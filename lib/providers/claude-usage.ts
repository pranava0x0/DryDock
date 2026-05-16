import { promises as fs, createReadStream } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";

/**
 * Claude Code session-log reader.
 *
 * Walks `~/.claude/projects/*\/*.jsonl` and aggregates the `message.usage`
 * blocks emitted by Claude Code on every assistant turn. Each line is a
 * full JSON event; we only care about assistant messages with a `usage`
 * field. Everything else (user messages, queue ops, system events, tool
 * results) is skipped.
 *
 * Why this works as a "Claude budget" signal: Claude Code subscriptions
 * (Pro/Max) have no public usage API, but Code itself logs every turn's
 * token counts locally as it runs. Aggregating those gives a real-numbers
 * view of "what have I actually spent on Claude this week / month" that's
 * directly comparable to Anthropic's rate-limit semantics (weekly token
 * cap on Pro/Max).
 *
 * Privacy: we only sum numeric fields (`input_tokens`, `output_tokens`,
 * `cache_creation_input_tokens`, `cache_read_input_tokens`). Message
 * content is never read or returned.
 */

export interface UsageWindow {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  sessions: number;
  assistantTurns: number;
}

export interface ClaudeUsageReport {
  /** Last 7 days, rolling. Matches Claude Pro/Max weekly reset semantics. */
  weekly: UsageWindow;
  /** Current calendar month. Matches the existing BudgetWidget's monthly cycle. */
  monthly: UsageWindow;
  /** ISO timestamp of the newest assistant turn we saw. null if nothing read. */
  latestTurnAt: string | null;
  /** Number of session jsonl files scanned (whether or not they had usage). */
  filesScanned: number;
  /** Captured at end of aggregation so callers can show "fresh as of …". */
  generatedAt: string;
}

const empty = (): UsageWindow => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  sessions: 0,
  assistantTurns: 0,
});

/**
 * Top-level reader. Defaults to `~/.claude/projects` so production callers
 * don't need to pass anything; tests inject a fixture dir.
 */
export async function readClaudeUsage(
  rootDir: string = join(homedir(), ".claude", "projects"),
  now: Date = new Date(),
): Promise<ClaudeUsageReport> {
  const weeklyCutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  // Build the monthly cutoff in UTC so it lines up with the ISO timestamps
  // Claude Code writes. Without `Date.UTC`, a positive local-tz offset
  // would push the cutoff past Jan-Nth 00:00 UTC and silently drop turns
  // that happened in the first hours of the month.
  const monthlyCutoff = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  );

  const weekly = empty();
  const monthly = empty();
  // Track sessions per window via Sets (a single session can span the
  // weekly cutoff — count it in both windows if it has turns in each).
  const weeklySessions = new Set<string>();
  const monthlySessions = new Set<string>();

  let latestTurnAt: string | null = null;
  let filesScanned = 0;

  let projectDirs: string[] = [];
  try {
    projectDirs = await fs.readdir(rootDir);
  } catch {
    // No ~/.claude/projects yet (fresh install, or user doesn't run Code
    // on this machine). Return zeros — UI surfaces "no data yet" cleanly.
    return finalize(weekly, monthly, latestTurnAt, filesScanned);
  }

  for (const entry of projectDirs) {
    const subPath = join(rootDir, entry);
    let stat;
    try {
      stat = await fs.stat(subPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    let files: string[] = [];
    try {
      files = await fs.readdir(subPath);
    } catch {
      continue;
    }

    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      filesScanned += 1;
      const filePath = join(subPath, f);
      const sessionId = f.replace(/\.jsonl$/, "");

      await aggregateFile(filePath, sessionId, {
        weeklyCutoff,
        monthlyCutoff,
        weekly,
        monthly,
        weeklySessions,
        monthlySessions,
        onLatest: (ts) => {
          if (latestTurnAt === null || ts > latestTurnAt) latestTurnAt = ts;
        },
      });
    }
  }

  weekly.sessions = weeklySessions.size;
  monthly.sessions = monthlySessions.size;

  return finalize(weekly, monthly, latestTurnAt, filesScanned);
}

function finalize(
  weekly: UsageWindow,
  monthly: UsageWindow,
  latestTurnAt: string | null,
  filesScanned: number,
): ClaudeUsageReport {
  return {
    weekly,
    monthly,
    latestTurnAt,
    filesScanned,
    generatedAt: new Date().toISOString(),
  };
}

interface AggregateContext {
  weeklyCutoff: Date;
  monthlyCutoff: Date;
  weekly: UsageWindow;
  monthly: UsageWindow;
  weeklySessions: Set<string>;
  monthlySessions: Set<string>;
  onLatest: (timestamp: string) => void;
}

async function aggregateFile(
  filePath: string,
  sessionId: string,
  ctx: AggregateContext,
): Promise<void> {
  // Streaming line-by-line — some jsonl files are >1MB; loading them
  // whole would cost more memory than necessary.
  const stream = createReadStream(filePath, { encoding: "utf-8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (line.length === 0) continue;
      // Fast-path: skip lines that can't contain a usage block at all,
      // saving a JSON.parse on user messages, queue ops, etc.
      if (!line.includes('"usage"')) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // Truncated final write, half-flushed line, whatever. Skip.
        continue;
      }
      if (!isPlainObject(parsed)) continue;

      const ts = typeof parsed.timestamp === "string" ? parsed.timestamp : null;
      const message = isPlainObject(parsed.message) ? parsed.message : null;
      const usage = message && isPlainObject(message.usage) ? message.usage : null;
      if (!ts || !usage) continue;

      const turnTime = new Date(ts);
      if (Number.isNaN(turnTime.getTime())) continue;

      const turn = {
        inputTokens: numOr0(usage.input_tokens),
        outputTokens: numOr0(usage.output_tokens),
        cacheCreationInputTokens: numOr0(usage.cache_creation_input_tokens),
        cacheReadInputTokens: numOr0(usage.cache_read_input_tokens),
      };

      ctx.onLatest(ts);

      if (turnTime >= ctx.monthlyCutoff) {
        addInto(ctx.monthly, turn);
        ctx.monthly.assistantTurns += 1;
        ctx.monthlySessions.add(sessionId);
      }
      if (turnTime >= ctx.weeklyCutoff) {
        addInto(ctx.weekly, turn);
        ctx.weekly.assistantTurns += 1;
        ctx.weeklySessions.add(sessionId);
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

function addInto(window: UsageWindow, turn: Omit<UsageWindow, "sessions" | "assistantTurns">): void {
  window.inputTokens += turn.inputTokens;
  window.outputTokens += turn.outputTokens;
  window.cacheCreationInputTokens += turn.cacheCreationInputTokens;
  window.cacheReadInputTokens += turn.cacheReadInputTokens;
}

function numOr0(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
