import { promises as fs, createReadStream, type Dirent } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { mayContainRecentTurns, widestCutoff } from "./usage-mtime";

/**
 * Claude Code session-log reader.
 *
 * Walks every `.jsonl` under `~/.claude/projects/` — including the nested
 * `<sessionId>/subagents/agent-*.jsonl` logs — and aggregates the
 * `message.usage` blocks emitted by Claude Code on every assistant turn.
 * Each line is a full JSON event; we only care about assistant messages
 * with a `usage` field. Everything else (user messages, queue ops, system
 * events, tool results) is skipped.
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
  /** Rolling 5-hour window — matches Claude Code's session rate-limit period. */
  fiveHour: UsageWindow;
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
  const fiveHourCutoff = new Date(now.getTime() - 5 * 60 * 60 * 1000);
  const weeklyCutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  // Build the monthly cutoff in UTC so it lines up with the ISO timestamps
  // Claude Code writes. Without `Date.UTC`, a positive local-tz offset
  // would push the cutoff past Jan-Nth 00:00 UTC and silently drop turns
  // that happened in the first hours of the month.
  const monthlyCutoff = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  );
  // Files last written before this can't hold a turn in any window — skip
  // them without reading. The monthly cutoff (1st of month) is normally the
  // earliest; weekly is included in case a rollover makes it earlier.
  const skipBefore = widestCutoff(monthlyCutoff, weeklyCutoff);

  const fiveHour = empty();
  const weekly = empty();
  const monthly = empty();
  // Track sessions per window via Sets (a single session can span the
  // weekly cutoff — count it in both windows if it has turns in each).
  const fiveHourSessions = new Set<string>();
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
    return finalize(fiveHour, weekly, monthly, latestTurnAt, filesScanned);
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

    for (const filePath of await collectSessionLogs(subPath)) {
      // Cheap stat gate before the expensive streaming read.
      if (!(await mayContainRecentTurns(filePath, skipBefore))) continue;
      filesScanned += 1;
      // Only a fallback: every record carries its own `sessionId`, and for a
      // subagent log that is the *parent* session — which is what we want to
      // count, since a subagent isn't a separate session.
      const fallbackSessionId = basename(filePath).replace(/\.jsonl$/, "");

      await aggregateFile(filePath, fallbackSessionId, {
        fiveHourCutoff,
        weeklyCutoff,
        monthlyCutoff,
        fiveHour,
        weekly,
        monthly,
        fiveHourSessions,
        weeklySessions,
        monthlySessions,
        onLatest: (ts) => {
          if (latestTurnAt === null || ts > latestTurnAt) latestTurnAt = ts;
        },
      });
    }
  }

  fiveHour.sessions = fiveHourSessions.size;
  weekly.sessions = weeklySessions.size;
  monthly.sessions = monthlySessions.size;

  return finalize(fiveHour, weekly, monthly, latestTurnAt, filesScanned);
}

/**
 * Every `.jsonl` under a project directory, at any depth.
 *
 * Subagent transcripts live *below* the main session log, at
 * `<project>/<sessionId>/subagents/agent-*.jsonl` (and one level deeper
 * again when a subagent spawns its own). A single-level `readdir` of the
 * project directory therefore misses all of them. On the machine where this
 * was found that was 636 of 857 files — and 54% of the week's input tokens
 * — absent from the totals with nothing on screen to suggest a gap.
 *
 * Subagent turns bill to the same account and count against the same
 * rate-limit window as the main loop, so excluding them doesn't make the
 * number conservative, it makes it wrong.
 */
async function collectSessionLogs(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await collectSessionLogs(path)));
    else if (entry.name.endsWith(".jsonl")) out.push(path);
  }
  return out;
}

function finalize(
  fiveHour: UsageWindow,
  weekly: UsageWindow,
  monthly: UsageWindow,
  latestTurnAt: string | null,
  filesScanned: number,
): ClaudeUsageReport {
  return {
    fiveHour,
    weekly,
    monthly,
    latestTurnAt,
    filesScanned,
    generatedAt: new Date().toISOString(),
  };
}

interface AggregateContext {
  fiveHourCutoff: Date;
  weeklyCutoff: Date;
  monthlyCutoff: Date;
  fiveHour: UsageWindow;
  weekly: UsageWindow;
  monthly: UsageWindow;
  fiveHourSessions: Set<string>;
  weeklySessions: Set<string>;
  monthlySessions: Set<string>;
  onLatest: (timestamp: string) => void;
}

async function aggregateFile(
  filePath: string,
  fallbackSessionId: string,
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

      // A subagent log's records carry the parent session's id, so session
      // counts stay honest (one session, however many agents it spawned)
      // while the agents' tokens still land in the totals.
      const sessionId =
        typeof parsed.sessionId === "string" && parsed.sessionId.length > 0
          ? parsed.sessionId
          : fallbackSessionId;

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
      if (turnTime >= ctx.fiveHourCutoff) {
        addInto(ctx.fiveHour, turn);
        ctx.fiveHour.assistantTurns += 1;
        ctx.fiveHourSessions.add(sessionId);
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
