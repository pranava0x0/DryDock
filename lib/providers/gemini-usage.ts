import { promises as fs, createReadStream } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { mayContainRecentTurns, widestCutoff } from "./usage-mtime";
import {
  readAntigravityCliActivity,
  type AntigravityCliReport,
} from "./antigravity-cli";

/**
 * Google AI (Antigravity) activity reader.
 *
 * Walks `~/.gemini/antigravity/brain/*\/.system_generated/logs/*` step logs
 * and aggregates per-conversation activity into rolling windows. Each log
 * line is a full JSON step event:
 *
 *   { step_index, source, type, status, created_at, tool_calls?, ... }
 *
 * Older conversations write `overview.txt`; newer ones write
 * `transcript.jsonl`. Both share the same line shape, so we read every
 * `.txt`/`.jsonl` file under each conversation's `logs/` directory.
 *
 * Why this is "activity, not tokens": unlike Claude Code, Antigravity does
 * not persist token counts anywhere on disk (verified: no `tokenCount`,
 * `input_tokens`, or `usageMetadata` in any text file or protobuf), and
 * Google AI Pro / Gemini subscriptions have no public usage API. The step
 * log is the only machine-readable signal of "how much have I used Google
 * AI locally", so we surface counts — user prompts, model turns, tool
 * calls — windowed the same way the Claude card windows tokens.
 *
 * Privacy: the reader `JSON.parse`s each line, so message `content` /
 * `thinking` does pass through memory — but only `source`, `type`,
 * `created_at`, and the *length* of `tool_calls` are ever inspected,
 * aggregated, stored, or returned. Stated this way deliberately: the
 * older "content is never read" phrasing promised privacy reviewers a
 * stronger guarantee than the code delivers (Codex, PR #8).
 */

export interface GeminiActivityWindow {
  /** User-authored prompts (steps of type USER_INPUT). */
  userPrompts: number;
  /** Model responses (steps of type PLANNER_RESPONSE). */
  modelTurns: number;
  /** Tool calls the model issued (summed length of each step's tool_calls). */
  toolCalls: number;
  /** Distinct conversations with at least one step in this window. */
  conversations: number;
}

export interface GeminiUsageReport {
  /** Last 7 days, rolling — mirrors the Claude card's weekly window. */
  weekly: GeminiActivityWindow;
  /** Current calendar month (UTC) — mirrors the Claude card's monthly window. */
  monthly: GeminiActivityWindow;
  /** ISO timestamp of the newest step we saw. null if nothing read. */
  latestActivityAt: string | null;
  /** Number of conversation log files scanned (whether or not in-window). */
  conversationsScanned: number;
  /** Captured at end of aggregation so callers can show "fresh as of …". */
  generatedAt: string;
  /**
   * The `agy` CLI's separate SQLite store (DD-BL-38). Reported alongside
   * — not merged into — the IDE windows above, because its schema is
   * unverified and its health may be `unavailable` while the IDE numbers
   * are perfectly good. Merging would hide that distinction.
   */
  cli: AntigravityCliReport;
}

const empty = (): GeminiActivityWindow => ({
  userPrompts: 0,
  modelTurns: 0,
  toolCalls: 0,
  conversations: 0,
});

/**
 * Top-level reader. Defaults to `~/.gemini/antigravity/brain` so production
 * callers don't need to pass anything; tests inject a fixture dir.
 */
export async function readGeminiUsage(
  rootDir: string = join(homedir(), ".gemini", "antigravity", "brain"),
  now: Date = new Date(),
  // Absolute rather than derived from `rootDir`: the CLI store is not a
  // sibling of the IDE's brain dir, and deriving it by walking up two
  // levels from a fixture path would have tests reading whatever happens
  // to sit next to the OS temp directory.
  cliDir: string = join(homedir(), ".gemini", "antigravity-cli"),
): Promise<GeminiUsageReport> {
  const weeklyCutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  // Build the monthly cutoff in UTC so it lines up with the ISO timestamps
  // Antigravity writes (always `…Z`). See claude-usage.ts for the same note.
  const monthlyCutoff = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  );
  // Skip log files last touched before every window (see usage-mtime).
  const skipBefore = widestCutoff(monthlyCutoff, weeklyCutoff);

  const weekly = empty();
  const monthly = empty();
  const weeklyConversations = new Set<string>();
  const monthlyConversations = new Set<string>();

  let latestActivityAt: string | null = null;
  let conversationsScanned = 0;

  // The CLI store is independent of the IDE walk — probe it either way so
  // a CLI-only user isn't reported as having zero activity.
  const cli = await readAntigravityCliActivity(cliDir, weeklyCutoff);

  let convDirs: string[] = [];
  try {
    convDirs = await fs.readdir(rootDir);
  } catch {
    // No ~/.gemini/antigravity/brain yet (Antigravity never run on this
    // machine). Return zeros — UI surfaces "no activity yet" cleanly.
    return finalize(weekly, monthly, latestActivityAt, conversationsScanned, cli);
  }

  for (const conv of convDirs) {
    const logsDir = join(rootDir, conv, ".system_generated", "logs");
    let logFiles: string[] = [];
    try {
      logFiles = await fs.readdir(logsDir);
    } catch {
      // Not a conversation dir (e.g. `tempmediaStorage`) or no logs yet.
      continue;
    }

    let scannedThisConv = false;
    for (const f of logFiles) {
      if (!f.endsWith(".jsonl") && !f.endsWith(".txt")) continue;
      const logPath = join(logsDir, f);
      if (!(await mayContainRecentTurns(logPath, skipBefore))) continue;
      scannedThisConv = true;
      await aggregateLog(logPath, conv, {
        weeklyCutoff,
        monthlyCutoff,
        weekly,
        monthly,
        weeklyConversations,
        monthlyConversations,
        onLatest: (ts) => {
          if (latestActivityAt === null || ts > latestActivityAt)
            latestActivityAt = ts;
        },
      });
    }
    if (scannedThisConv) conversationsScanned += 1;
  }

  weekly.conversations = weeklyConversations.size;
  monthly.conversations = monthlyConversations.size;

  return finalize(weekly, monthly, latestActivityAt, conversationsScanned, cli);
}

function finalize(
  weekly: GeminiActivityWindow,
  monthly: GeminiActivityWindow,
  latestActivityAt: string | null,
  conversationsScanned: number,
  cli: AntigravityCliReport,
): GeminiUsageReport {
  return {
    weekly,
    monthly,
    latestActivityAt,
    conversationsScanned,
    generatedAt: new Date().toISOString(),
    cli,
  };
}

interface AggregateContext {
  weeklyCutoff: Date;
  monthlyCutoff: Date;
  weekly: GeminiActivityWindow;
  monthly: GeminiActivityWindow;
  weeklyConversations: Set<string>;
  monthlyConversations: Set<string>;
  onLatest: (timestamp: string) => void;
}

async function aggregateLog(
  filePath: string,
  conversationId: string,
  ctx: AggregateContext,
): Promise<void> {
  // Streaming line-by-line — transcript.jsonl files run to several MB;
  // loading them whole would cost more memory than necessary.
  const stream = createReadStream(filePath, { encoding: "utf-8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (line.length === 0) continue;
      // Fast-path: every real step line carries a timestamp. Skip anything
      // that can't, saving a JSON.parse on blanks / partial writes.
      if (!line.includes('"created_at"')) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // Truncated final write, half-flushed line, whatever. Skip.
        continue;
      }
      if (!isPlainObject(parsed)) continue;

      const ts =
        typeof parsed.created_at === "string" ? parsed.created_at : null;
      if (!ts) continue;
      const stepTime = new Date(ts);
      if (Number.isNaN(stepTime.getTime())) continue;

      const type = typeof parsed.type === "string" ? parsed.type : "";
      const toolCalls = Array.isArray(parsed.tool_calls)
        ? parsed.tool_calls.length
        : 0;

      ctx.onLatest(ts);

      if (stepTime >= ctx.monthlyCutoff) {
        addStep(ctx.monthly, type, toolCalls);
        ctx.monthlyConversations.add(conversationId);
      }
      if (stepTime >= ctx.weeklyCutoff) {
        addStep(ctx.weekly, type, toolCalls);
        ctx.weeklyConversations.add(conversationId);
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

function addStep(
  window: GeminiActivityWindow,
  type: string,
  toolCalls: number,
): void {
  if (type === "USER_INPUT") window.userPrompts += 1;
  else if (type === "PLANNER_RESPONSE") window.modelTurns += 1;
  window.toolCalls += toolCalls;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
