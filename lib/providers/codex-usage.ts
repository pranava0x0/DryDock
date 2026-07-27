import { promises as fs, createReadStream } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { mayContainRecentTurns, widestCutoff } from "./usage-mtime";

/**
 * OpenAI Codex CLI session-log reader.
 *
 * Recursively walks `~/.codex/sessions/**\/*.jsonl` (the CLI nests rollout
 * files under `YYYY/MM/DD/`) and sums the per-turn token usage the Codex
 * CLI records on every model turn. Each line is one JSON "rollout" event;
 * we only care about `token_count` events, which carry the turn's token
 * counts. Everything else (response items, session meta, etc.) is skipped.
 *
 * Why this works as a "Codex budget" signal: same idea as the Claude card —
 * the Codex CLI has no public usage API, but it logs every turn's token
 * counts locally as it runs. Aggregating those gives a real-numbers view of
 * Codex spend per week / month.
 *
 * ── FORMAT (validated against real rollout files) ───────────────────────
 * Each token_count line looks like:
 *
 *   {"timestamp":"<ISO>","type":"event_msg",
 *    "payload":{"type":"token_count",
 *      "info":{"last_token_usage":{input_tokens,cached_input_tokens,
 *              output_tokens,reasoning_output_tokens,total_tokens},
 *              "total_token_usage":{…}}}}
 *
 * Confirmed semantics: `total_token_usage` is CUMULATIVE across the session
 * (grows every turn) and `last_token_usage` is that turn's DELTA — verified
 * because Σ(last.input) over a session equals the final total.input. So we
 * sum `last_token_usage`, which makes time-windowing correct and avoids the
 * double-count that summing the cumulative total would cause. The parser
 * also accepts an unwrapped `{type:"token_count",info:{…}}` and degrades to
 * zeros rather than throwing when `~/.codex/sessions` is absent (UI shows
 * "no data yet").
 *
 * ── ARCHIVED SESSIONS (DD-BL-38) ────────────────────────────────────────
 * Codex's `/archive` command MOVES a rollout out of `sessions/YYYY/MM/DD/`
 * into a flat `~/.codex/archived_sessions/`. Reading only `sessions/` made
 * archived work silently vanish from the totals — the same bug ccusage hit
 * (PR #849). We now read both roots. `archivedDirFor` derives the archive
 * as a *sibling of the sessions root* so fixtures get the same treatment
 * as production without a second parameter to thread through.
 *
 * Privacy: we only read numeric token fields and the line timestamp.
 * Prompt / response content is never read or returned.
 */

export interface CodexUsageWindow {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  sessions: number;
  turns: number;
}

export interface CodexUsageReport {
  /** Last 7 days, rolling. */
  weekly: CodexUsageWindow;
  /** Current calendar month (UTC). */
  monthly: CodexUsageWindow;
  /** ISO timestamp of the newest token_count turn we saw. null if none. */
  latestTurnAt: string | null;
  /** Number of rollout jsonl files scanned (whether or not they had usage). */
  filesScanned: number;
  /** Captured at end of aggregation so callers can show "fresh as of …". */
  generatedAt: string;
}

const empty = (): CodexUsageWindow => ({
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
  sessions: 0,
  turns: 0,
});

/**
 * Top-level reader. Defaults to `~/.codex/sessions` so production callers
 * don't need to pass anything; tests inject a fixture dir.
 */
export async function readCodexUsage(
  rootDir: string = join(homedir(), ".codex", "sessions"),
  now: Date = new Date(),
): Promise<CodexUsageReport> {
  const weeklyCutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  // UTC month start, same reasoning as claude-usage.ts (ISO timestamps).
  const monthlyCutoff = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  );

  // Skip rollout files last written before every window (see usage-mtime).
  const skipBefore = widestCutoff(monthlyCutoff, weeklyCutoff);

  const weekly = empty();
  const monthly = empty();
  const weeklySessions = new Set<string>();
  const monthlySessions = new Set<string>();

  let latestTurnAt: string | null = null;
  let filesScanned = 0;

  const files = await collectRolloutFiles(rootDir);
  if (files.length === 0) {
    // No ~/.codex/sessions yet (Codex CLI never run here). Return zeros —
    // UI surfaces "no data yet" cleanly.
    return finalize(weekly, monthly, latestTurnAt, filesScanned);
  }

  for (const { path: filePath, sessionKey } of files) {
    if (!(await mayContainRecentTurns(filePath, skipBefore))) continue;
    filesScanned += 1;
    // One session per rollout file, keyed by rollout identity (not the
    // absolute path) so archiving a session mid-window doesn't make it
    // count as two.
    await aggregateFile(filePath, sessionKey, {
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

  weekly.sessions = weeklySessions.size;
  monthly.sessions = monthlySessions.size;

  return finalize(weekly, monthly, latestTurnAt, filesScanned);
}

/**
 * The archive root for a given sessions root — its sibling
 * `archived_sessions/`. Exported for the connector and the tests; keeping
 * it derived (rather than a second argument) means a fixture directory
 * laid out like `~/.codex` exercises both roots for free.
 */
export function archivedDirFor(sessionsRoot: string): string {
  return join(dirname(sessionsRoot), "archived_sessions");
}

/** A rollout file plus the identity we count sessions by. */
export interface RolloutFile {
  path: string;
  /**
   * Stable identity for the rollout. The session UUID from the filename
   * when it parses (`rollout-<ISO>-<uuid>.jsonl`), else the path relative
   * to its own root.
   *
   * Why not the absolute path: `sessions/2026/07/25/rollout-…-<uuid>.jsonl`
   * and `archived_sessions/rollout-…-<uuid>.jsonl` are the *same* session
   * before and after `/archive`, and the archive is flat — so the relative
   * paths differ too and can't pair them (the plan assumed the archive
   * mirrored the date tree; on disk it doesn't). The embedded UUID is the
   * only thing that survives the move. Anything that doesn't match the
   * rollout pattern falls back to the relative path rather than the bare
   * basename, so two genuinely-different files can never collapse into one.
   */
  sessionKey: string;
}

const ROLLOUT_UUID =
  /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

function sessionKeyFor(rootDir: string, filePath: string): string {
  const match = basename(filePath).match(ROLLOUT_UUID);
  if (match) return match[1].toLowerCase();
  return relative(rootDir, filePath);
}

/**
 * Every rollout file across the live sessions root and its archive,
 * deduped by session identity. The live copy wins when both exist (it is
 * the one still being appended to). Returns an empty array — rather than
 * throwing — when neither root is readable; "Codex was never run here" is
 * an expected state, not an error.
 */
export async function collectRolloutFiles(
  rootDir: string,
): Promise<RolloutFile[]> {
  const byKey = new Map<string, RolloutFile>();
  // Order matters: the live root is walked first so its entry wins the
  // `has` check below if a rollout somehow exists in both places.
  for (const root of [rootDir, archivedDirFor(rootDir)]) {
    let paths: string[];
    try {
      paths = await collectJsonlFiles(root);
    } catch {
      continue;
    }
    for (const path of paths) {
      const sessionKey = sessionKeyFor(root, path);
      if (!byKey.has(sessionKey)) byKey.set(sessionKey, { path, sessionKey });
    }
  }
  return [...byKey.values()];
}

/**
 * Recursively gather every `.jsonl` file under `rootDir`. Codex nests
 * rollouts under `YYYY/MM/DD/`, but flat layouts (the archive, and older
 * versions) work too since we just walk whatever directory tree is there.
 * Throws if `rootDir` itself can't be read, so the caller can treat that
 * as the empty case.
 */
async function collectJsonlFiles(rootDir: string): Promise<string[]> {
  const out: string[] = [];
  // readdir the root first — if this throws, the caller's catch handles it.
  const rootEntries = await fs.readdir(rootDir, { withFileTypes: true });
  const stack = rootEntries.map((e) => ({ dir: rootDir, entry: e }));

  while (stack.length > 0) {
    const { dir, entry } = stack.pop()!;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      let children;
      try {
        children = await fs.readdir(full, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const c of children) stack.push({ dir: full, entry: c });
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      out.push(full);
    }
  }
  return out;
}

function finalize(
  weekly: CodexUsageWindow,
  monthly: CodexUsageWindow,
  latestTurnAt: string | null,
  filesScanned: number,
): CodexUsageReport {
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
  weekly: CodexUsageWindow;
  monthly: CodexUsageWindow;
  weeklySessions: Set<string>;
  monthlySessions: Set<string>;
  onLatest: (timestamp: string) => void;
}

interface CodexTurn {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

async function aggregateFile(
  filePath: string,
  sessionId: string,
  ctx: AggregateContext,
): Promise<void> {
  const stream = createReadStream(filePath, { encoding: "utf-8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (line.length === 0) continue;
      // Fast-path: skip lines that can't be a token_count event.
      if (!line.includes("token_count")) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isPlainObject(parsed)) continue;

      const turn = extractTurn(parsed);
      if (!turn) continue;

      const ts = extractTimestamp(parsed);
      if (!ts) continue;
      const turnTime = new Date(ts);
      if (Number.isNaN(turnTime.getTime())) continue;

      ctx.onLatest(ts);

      if (turnTime >= ctx.monthlyCutoff) {
        addInto(ctx.monthly, turn);
        ctx.monthly.turns += 1;
        ctx.monthlySessions.add(sessionId);
      }
      if (turnTime >= ctx.weeklyCutoff) {
        addInto(ctx.weekly, turn);
        ctx.weekly.turns += 1;
        ctx.weeklySessions.add(sessionId);
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

/**
 * Pull the per-turn token usage out of a rollout line, if it is a
 * `token_count` event. Tolerant of the wrapped (`event_msg` → `payload`)
 * and unwrapped shapes. Returns null for any other line.
 */
function extractTurn(parsed: Record<string, unknown>): CodexTurn | null {
  // Locate the token_count payload object.
  let payload: Record<string, unknown> | null = null;
  if (parsed.type === "event_msg" && isPlainObject(parsed.payload)) {
    payload = parsed.payload;
  } else if (isPlainObject(parsed.payload)) {
    payload = parsed.payload;
  } else {
    payload = parsed;
  }
  if (!payload || payload.type !== "token_count") return null;

  const info = isPlainObject(payload.info) ? payload.info : null;
  if (!info) return null;

  // Prefer the per-turn delta; time-windowing depends on it.
  const usage = isPlainObject(info.last_token_usage)
    ? info.last_token_usage
    : null;
  if (!usage) return null;

  return {
    inputTokens: numOr0(usage.input_tokens),
    cachedInputTokens: numOr0(usage.cached_input_tokens),
    outputTokens: numOr0(usage.output_tokens),
    reasoningOutputTokens: numOr0(usage.reasoning_output_tokens),
    totalTokens: numOr0(usage.total_tokens),
  };
}

/** Top-level line timestamp (wrapped format) with a payload fallback. */
function extractTimestamp(parsed: Record<string, unknown>): string | null {
  if (typeof parsed.timestamp === "string") return parsed.timestamp;
  if (isPlainObject(parsed.payload) && typeof parsed.payload.timestamp === "string") {
    return parsed.payload.timestamp;
  }
  return null;
}

function addInto(window: CodexUsageWindow, turn: CodexTurn): void {
  window.inputTokens += turn.inputTokens;
  window.cachedInputTokens += turn.cachedInputTokens;
  window.outputTokens += turn.outputTokens;
  window.reasoningOutputTokens += turn.reasoningOutputTokens;
  window.totalTokens += turn.totalTokens;
}

function numOr0(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
