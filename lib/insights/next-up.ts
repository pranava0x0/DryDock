import type { OverviewTodo } from "./overview";
// `.types`, not the reader: this module is reachable from a client
// component, and importing the `node:fs`-backed module would break the
// browser build the moment anything here became a value import.
import type { RecentSession } from "@/lib/connectors/recent-sessions.types";

/**
 * "What should I work on next?" — the one line at the very top of the
 * dashboard.
 *
 * ── Why this is a ranking and not a score ───────────────────────────────
 * Everything here is a heuristic over signals we already fetch, and a
 * single blended score would let a weak signal outvote a strong one for
 * reasons nobody could reconstruct. Instead each candidate lands in a
 * named tier, ties break on recency, and every suggestion carries the
 * `why` string that put it there — so a suggestion you disagree with tells
 * you what it was reasoning from.
 *
 * ── The honesty rule ────────────────────────────────────────────────────
 * When GitHub couldn't be read, "nothing to work on" would be a lie. The
 * caller passes `todosAvailable: false` and the result says the list is
 * partial rather than rendering an empty, confident recommendation.
 */

export type NextUpKind = "resume" | "review" | "unblock" | "issue";

export interface NextUpItem {
  kind: NextUpKind;
  /** Stable identity for React keys and dedupe. */
  key: string;
  title: string;
  /** The single sentence explaining why this is on top. */
  why: string;
  /** Where to go. Null for a resume suggestion, which is a local action. */
  url: string | null;
  project: string | null;
  /** Free-text second line — branch, repo, tool. */
  context: string | null;
  ageDays: number | null;
}

export interface NextUp {
  items: NextUpItem[];
  /**
   * True when at least one input could not be read, so an empty or short
   * list must not be presented as "there is nothing else".
   */
  partial: boolean;
  reason: string | null;
}

/**
 * A session this recent is the thing you were most likely doing when you
 * closed the laptop. Beyond it, an open PR is the better suggestion.
 */
const RESUME_WINDOW_HOURS = 36;

/**
 * Past this, an open PR reads as abandoned rather than in-flight, and
 * suggesting it as "next" every day is how a recommendation surface
 * becomes noise. The overview already demotes these; this drops them.
 */
const STALE_DAYS = 180;

/** Titles that mark a scheduled run rather than something you chose to do. */
const AUTOMATED_TITLE = /\b(daily|nightly|sweep|digest|cron|scheduled|automated)\b/i;

function hoursSince(iso: string, now: number): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? (now - ms) / 3_600_000 : Number.POSITIVE_INFINITY;
}

export interface NextUpInput {
  sessions: RecentSession[];
  todos: OverviewTodo[];
  todosAvailable: boolean;
  todosReason: string | null;
  /** Injected so tests are not clock-dependent. */
  now?: Date;
  limit?: number;
}

export function buildNextUp(input: NextUpInput): NextUp {
  const now = (input.now ?? new Date()).getTime();
  const limit = input.limit ?? 3;
  const items: NextUpItem[] = [];

  // ── Tier 1: resume the session you were just in ──────────────────────
  // Scheduled runs are excluded: "resume the nightly sweep" is never the
  // answer to "what should I work on", and those sessions are the most
  // frequent thing in the log precisely because nobody chose them.
  const resumable = input.sessions.find(
    (s) =>
      hoursSince(s.endedAt, now) <= RESUME_WINDOW_HOURS &&
      !AUTOMATED_TITLE.test(s.title),
  );
  if (resumable) {
    const hours = Math.round(hoursSince(resumable.endedAt, now));
    items.push({
      kind: "resume",
      key: `resume:${resumable.tool}:${resumable.id}`,
      title: resumable.title,
      why:
        hours <= 1
          ? "You were in this less than an hour ago"
          : `You were in this ${hours}h ago — most recent thing you actually drove`,
      url: null,
      project: resumable.project,
      context: [resumable.branch, resumable.lastPrompt].filter(Boolean).join(" · ") || null,
      ageDays: Math.floor(hours / 24),
    });
  }

  // ── Tier 2: your open PRs, freshest first ────────────────────────────
  // A PR you opened is work already done that isn't landed — the highest
  // value-per-minute item on the board.
  const fresh = input.todos.filter(
    (t) => t.ageDays === null || t.ageDays <= STALE_DAYS,
  );
  for (const todo of fresh.filter((t) => t.kind === "pr")) {
    items.push({
      kind: "review",
      key: todo.key,
      title: todo.title,
      why:
        todo.ageDays === null
          ? "Open PR — finished work that hasn't landed"
          : todo.ageDays === 0
            ? "Open PR, touched today — finish it while it's warm"
            : `Open PR sitting ${todo.ageDays}d — finished work that hasn't landed`,
      url: todo.url,
      project: todo.repository,
      context: `${todo.repository}#${todo.number}`,
      ageDays: todo.ageDays,
    });
  }

  // ── Tier 3: open issues ──────────────────────────────────────────────
  for (const todo of fresh.filter((t) => t.kind === "issue")) {
    items.push({
      kind: "issue",
      key: todo.key,
      title: todo.title,
      why:
        todo.ageDays === null
          ? "Open issue assigned to you"
          : `Open issue, last touched ${todo.ageDays}d ago`,
      url: todo.url,
      project: todo.repository,
      context: `${todo.repository}#${todo.number}`,
      ageDays: todo.ageDays,
    });
  }

  return {
    items: items.slice(0, limit),
    partial: !input.todosAvailable,
    reason: input.todosAvailable
      ? null
      : (input.todosReason ??
        "GitHub could not be read, so open PRs and issues are missing from this ranking"),
  };
}
