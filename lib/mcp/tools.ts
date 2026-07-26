import {
  getBacklogItem,
  inboxCount,
  listBacklog,
  type BacklogStatus,
} from "../db/backlog";
import { listTasks, getTask, type TaskStatus } from "../db/tasks";
import { listProjects } from "../db/projects";
import { intakeCapture } from "../orchestrator/intake";
import { burnDownBacklogItem, BurnDownError } from "../orchestrator/backlog";
import { usageBy, usageTotals } from "../db/usage";
import { dayKeyOffset, localDayKey } from "../util/day";

/**
 * The DryDock MCP tool surface (EP-14 Spec A).
 *
 * ── The tool set is per-caller, not global ──────────────────────────────
 * The nightly idea-generation session reads untrusted web content. An
 * earlier cut of this file withheld `dispatch_task` and exposed
 * everything else to every caller — which was **not enough**, and Codex
 * was right to say so on PR #8.
 *
 * The lethal trifecta is untrusted input + access to private data + a way
 * to exfiltrate or act. Withholding dispatch removes one exfiltration
 * route, but `list_backlog`, `list_tasks`, and `get_usage_stats` pull
 * private local state *into the context of a session that is already
 * reading attacker-controlled pages* — and that session has its own web
 * access to send it back out. `burn_down_item` is worse still: it mutates,
 * moving an accepted item to `in_progress` and creating a task.
 *
 * So the surface is now an explicit **allowlist per caller identity**:
 * the ideas session gets `add_backlog_item` and nothing else. Its entire
 * blast radius really is "propose spam into the inbox", which is what the
 * plan claimed all along and what the code now actually delivers.
 *
 * `burn_down_item` stays available to a *human-driven* session, where it
 * creates a **pending** task a person still has to run — the safety line
 * the UI already draws.
 *
 * ── Talks to the DB directly, not over HTTP ─────────────────────────────
 * These tools import `lib/db/*` in-process. A 7am briefing job must not
 * fail because the Next.js server happened to be down; the database file
 * is always there. It also means the same invariants (CAS claim,
 * external_id stamping, `ensure()` migrations) apply — which is exactly
 * why satellites are not allowed to open `~/.drydock/drydock.db`
 * themselves.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown> | unknown;
}

/** Callers can't claim to be something else — see `add_backlog_item`. */
export type CallerIdentity = "ai-generated" | "manual";

/**
 * Which tools each caller identity may see.
 *
 * Deliberately an **allowlist**, not a denylist. A denylist has to be
 * updated every time a tool is added, and forgetting is silent — a new
 * read tool would quietly become reachable from a session that reads
 * hostile web pages. With an allowlist, forgetting means the new tool
 * is simply unavailable until someone states that it should be.
 */
export const TOOLS_BY_CALLER: Record<CallerIdentity, readonly string[]> = {
  // Reads untrusted web content. Propose-only: no reads of private
  // local state, no mutations.
  "ai-generated": ["add_backlog_item"],
  // A human is driving. Read + propose + create-a-pending-task.
  manual: [
    "add_backlog_item",
    "list_backlog",
    "list_tasks",
    "get_task_status",
    "get_usage_stats",
    "burn_down_item",
  ],
};

function str(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

export function buildTools(caller: CallerIdentity): ToolDefinition[] {
  const allowed = new Set(TOOLS_BY_CALLER[caller] ?? []);
  return allTools(caller).filter((tool) => allowed.has(tool.name));
}

function allTools(caller: CallerIdentity): ToolDefinition[] {
  return [
    {
      name: "add_backlog_item",
      description:
        "Propose an item for the DryDock backlog. It lands in the inbox for human triage — it does NOT enter the backlog directly, and it is never pushed to Apple Notes until a human accepts it.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "One line. Required." },
          description: {
            type: "string",
            description: "Optional detail, e.g. a file:// path to a spec.",
          },
          project: {
            type: "string",
            description:
              "Optional project name. Fuzzy-matched; an ambiguous match assigns nothing.",
          },
          external_id: {
            type: "string",
            description:
              "Stable key for idempotency, e.g. the spec filename. Re-sending the same key updates rather than duplicating.",
          },
        },
        required: ["title"],
      },
      handler: (args) => {
        const title = str(args, "title");
        if (!title) throw new Error("`title` is required");
        const project = str(args, "project");
        const projects = listProjects();
        const matched = project
          ? (projects.find(
              (p) => p.name.toLowerCase() === project.toLowerCase(),
            )?.id ?? null)
          : null;

        const result = intakeCapture({
          text: project ? `${title} #${project}` : title,
          // The caller's identity is FORCED, never read from the
          // arguments. A tool that let its caller declare itself
          // 'manual' would let a machine write straight into the
          // trusted list, which is the entire thing the inbox prevents.
          source: caller === "ai-generated" ? "ai-generated" : "manual",
          externalId: str(args, "external_id"),
          description: str(args, "description"),
          projectId: matched,
          status: caller === "ai-generated" ? "proposed" : "idea",
        });

        return {
          outcome: result.outcome,
          id: result.item?.id ?? null,
          title: result.parsed.title,
          landed_in: "inbox",
          similar: result.similar.map((s) => s.title),
        };
      },
    },

    {
      name: "list_backlog",
      description:
        "List DryDock backlog items. Defaults to the accepted (triaged) list.",
      inputSchema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["idea", "in_progress", "done", "dropped", "proposed"],
          },
          stage: { type: "string", enum: ["inbox", "triaged", "all"] },
          limit: { type: "number" },
        },
      },
      handler: (args) => {
        const stageArg = str(args, "stage");
        const stage =
          stageArg === "inbox"
            ? ("inbox" as const)
            : stageArg === "all"
              ? undefined
              : ("triaged" as const);
        const status = str(args, "status") as BacklogStatus | null;
        const limit =
          typeof args.limit === "number" && args.limit > 0
            ? Math.min(200, Math.trunc(args.limit))
            : 50;

        const items = listBacklog({
          stage,
          ...(status ? { status } : {}),
        }).slice(0, limit);

        return {
          count: items.length,
          inbox_count: inboxCount(),
          items: items.map((i) => ({
            id: i.id,
            title: i.title,
            status: i.status,
            priority: i.priority,
            project_id: i.project_id,
            source: i.source,
            github_issue_ref: i.github_issue_ref,
          })),
        };
      },
    },

    {
      name: "list_tasks",
      description:
        "List orchestrator tasks. Use this to answer 'what needs my attention' — failed, gate-failed, and long-queued tasks.",
      inputSchema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: [
              "pending",
              "queued",
              "claimed",
              "running",
              "done",
              "failed",
            ],
          },
          limit: { type: "number" },
        },
      },
      handler: (args) => {
        const status = str(args, "status");
        const limit =
          typeof args.limit === "number" && args.limit > 0
            ? Math.min(200, Math.trunc(args.limit))
            : 50;
        // Validated against the closed union rather than passed
        // through — an unknown status should be an empty result the
        // caller can see, not a type assertion that silently matches
        // nothing.
        const valid: readonly string[] = [
          "pending",
          "queued",
          "claimed",
          "running",
          "done",
          "failed",
        ];
        if (status && !valid.includes(status)) {
          return { count: 0, tasks: [], error: `unknown status: ${status}` };
        }
        const tasks = listTasks(
          status ? { status: status as TaskStatus } : {},
        ).slice(0, limit);
        return {
          count: tasks.length,
          tasks: tasks.map((t) => ({
            id: t.id,
            title: t.title,
            status: t.status,
            provider: t.provider,
            project_id: t.project_id,
            pr_url: t.pr_url,
            updated_at: t.updated_at,
          })),
        };
      },
    },

    {
      name: "get_task_status",
      description: "Full status for one task, including its branch and PR.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
      handler: (args) => {
        const id = str(args, "id");
        if (!id) throw new Error("`id` is required");
        const task = getTask(id);
        if (!task) return { found: false };
        return { found: true, task };
      },
    },

    {
      name: "get_usage_stats",
      description:
        "AI usage across Claude, Codex, and Google over a recent window, from the local ledger. Google reports activity events, not tokens — it records no token counts anywhere.",
      inputSchema: {
        type: "object",
        properties: {
          days: { type: "number", description: "Window size, default 7." },
        },
      },
      handler: (args) => {
        const days =
          typeof args.days === "number" && args.days > 0
            ? Math.min(365, Math.trunc(args.days))
            : 7;
        const now = new Date();
        const range = {
          fromDay: dayKeyOffset(now, days - 1),
          toDay: localDayKey(now),
        };
        const totals = usageTotals(range);
        return {
          window_days: days,
          from: range.fromDay,
          to: range.toDay,
          // Claude + Codex only; Google contributes activity, not tokens.
          total_tokens: totals.total_tokens,
          turns: totals.turns,
          activity_events: totals.events,
          active_days: totals.days,
          by_provider: usageBy("provider", range).map((s) => ({
            provider: s.key,
            total_tokens: s.total_tokens,
            turns: s.turns,
            events: s.events,
          })),
          by_model: usageBy("model", range)
            .slice(0, 10)
            .map((s) => ({
              model: s.key || "unknown",
              total_tokens: s.total_tokens,
            })),
          note: "Google AI records no token counts locally; its usage appears as activity_events only.",
        };
      },
    },

    {
      name: "burn_down_item",
      description:
        "Turn an accepted backlog item into a PENDING orchestrator task. This does NOT run an agent — a human still has to start it.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          project_id: {
            type: "string",
            description: "Override the item's project.",
          },
        },
        required: ["id"],
      },
      handler: (args) => {
        const id = str(args, "id");
        if (!id) throw new Error("`id` is required");
        const item = getBacklogItem(id);
        if (!item) return { ok: false, reason: "no such backlog item" };
        // An untriaged item hasn't been accepted by a human yet. Letting
        // a machine burn one down would route around the inbox entirely.
        if (item.triaged_at === null) {
          return {
            ok: false,
            reason:
              "this item is still in the inbox — a human has to accept it first",
          };
        }
        try {
          const result = burnDownBacklogItem(id, str(args, "project_id"));
          return {
            ok: true,
            task_id: result.taskId,
            status: "pending",
            note: "Created as pending. A human still has to run it.",
          };
        } catch (err) {
          if (err instanceof BurnDownError) {
            return { ok: false, reason: err.message, code: err.code };
          }
          throw err;
        }
      },
    },
  ];
}

/**
 * Operations that exist nowhere in this surface, for any caller. Kept as
 * an explicit list so the omission reads as a stated decision rather than
 * something that happens to be missing — and so a future "just add
 * dispatch" reads as the deliberate reversal it would be.
 */
export const WITHHELD_TOOLS = [
  "dispatch_task",
  "run_task",
  "delete_backlog_item",
  "update_settings",
] as const;

/**
 * Additionally withheld from the untrusted (`ai-generated`) caller.
 * Every one of these either reads private local state into a
 * web-reading context or mutates orchestrator state.
 */
export const WITHHELD_FROM_UNTRUSTED = [
  "list_backlog",
  "list_tasks",
  "get_task_status",
  "get_usage_stats",
  "burn_down_item",
] as const;
