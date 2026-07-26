import { promises as fs, createReadStream } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { mayContainRecentTurns } from "../providers/usage-mtime";
import {
  projectKeyFromCwd,
  projectKeyFromEncodedDir,
} from "../providers/claude-projects";
import { localDayKey, localHour } from "../util/day";
import {
  emptyUsageRow,
  type UsageDailyRow,
  type UsageHourlyRow,
} from "../db/usage";

/**
 * One pass over `~/.claude/projects/*​/*.jsonl` producing everything
 * downstream epics need from Claude Code's logs.
 *
 * **Invariant: there is exactly one Claude JSONL reader for the ledger.**
 * EP-10 wants per-day/model/project token rows; EP-11 wants session
 * boundaries and the `pr-link` records that give an exact session↔PR
 * join. Those are the same 1.3 GB of files. Walking them twice would
 * double the cold-read cost of the most expensive thing DryDock reads,
 * and — worse — let the two readers drift apart on what counts as a turn.
 * If you need a third thing out of these logs, add it to `ScanResult`
 * here; do not add a second walker.
 *
 * (`lib/providers/claude-usage.ts` still exists and is untouched: it
 * answers a different question — rolling 5h/weekly/monthly windows for
 * the Settings cards — at a granularity days can't express.)
 *
 * Privacy: lines are `JSON.parse`d, so message content passes through
 * memory — but only numeric usage fields, timestamps, model ids, cwd,
 * branch name, and PR references are inspected, aggregated, stored, or
 * returned. The narrower phrasing is deliberate: "content is never read"
 * overpromised what the code does (Codex, PR #8).
 */

/** A `pr-link` record: Claude Code's own exact session→PR join. */
export interface PrLink {
  sessionId: string;
  prRepository: string;
  prNumber: number;
  prUrl: string;
  at: number;
}

export interface ScannedSession {
  session_id: string;
  cwd: string;
  project_key: string;
  git_branch: string | null;
  started_at: number;
  ended_at: number;
  /** The model with the most turns in the session. '' when unknown. */
  model: string;
  input_tokens: number;
  cached_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  total_tokens: number;
  turns: number;
  jsonl_path: string;
}

export interface ScanResult {
  /** Ledger rows for days at or after the scan's `since`. */
  daily: UsageDailyRow[];
  /** Turn counts by local hour, for the rhythm heatmap. */
  hourly: UsageHourlyRow[];
  sessions: ScannedSession[];
  prLinks: PrLink[];
  filesScanned: number;
  latestTurnAt: string | null;
  /** True when the projects root doesn't exist at all. */
  rootMissing: boolean;
}

interface Accumulator {
  row: UsageDailyRow;
  sessionIds: Set<string>;
}

interface SessionAccumulator {
  session_id: string;
  cwd: string;
  git_branch: string | null;
  startedAt: number;
  endedAt: number;
  modelTurns: Map<string, number>;
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  total: number;
  turns: number;
  jsonl_path: string;
  encodedDir: string;
}

export async function scanClaudeSessions(
  rootDir: string = join(homedir(), ".claude", "projects"),
  since: Date = new Date(0),
): Promise<ScanResult> {
  const daily = new Map<string, Accumulator>();
  const hourly = new Map<string, UsageHourlyRow>();
  const sessions = new Map<string, SessionAccumulator>();
  const prLinks: PrLink[] = [];
  let filesScanned = 0;
  let latestTurnAt: string | null = null;

  let projectDirs: string[];
  try {
    projectDirs = await fs.readdir(rootDir);
  } catch {
    return {
      daily: [],
      hourly: [],
      sessions: [],
      prLinks: [],
      filesScanned: 0,
      latestTurnAt: null,
      rootMissing: true,
    };
  }

  for (const encodedDir of projectDirs) {
    const subPath = join(rootDir, encodedDir);
    let files: string[];
    try {
      const stat = await fs.stat(subPath);
      if (!stat.isDirectory()) continue;
      files = await fs.readdir(subPath);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const filePath = join(subPath, file);
      // The same cheap stat gate the window readers use: a file whose
      // mtime predates `since` cannot hold a turn at or after it.
      if (!(await mayContainRecentTurns(filePath, since))) continue;
      filesScanned += 1;
      await scanFile(filePath, encodedDir, since, {
        daily,
        hourly,
        sessions,
        prLinks,
        onLatest: (ts) => {
          if (latestTurnAt === null || ts > latestTurnAt) latestTurnAt = ts;
        },
      });
    }
  }

  // Session counts are folded in at the end: a row's `sessions` is the
  // number of distinct sessions that contributed to that (day, model,
  // project) tuple, so a session spanning two models counts in both.
  // Summing `sessions` across dimensions therefore over-counts, which is
  // why the exact figure comes from the session records instead.
  for (const acc of daily.values()) {
    acc.row.sessions = acc.sessionIds.size;
  }

  return {
    daily: [...daily.values()].map((a) => a.row),
    hourly: [...hourly.values()],
    sessions: [...sessions.values()].map(finalizeSession),
    prLinks,
    filesScanned,
    latestTurnAt,
    rootMissing: false,
  };
}

function finalizeSession(acc: SessionAccumulator): ScannedSession {
  let model = "";
  let best = 0;
  for (const [name, count] of acc.modelTurns) {
    if (count > best) {
      best = count;
      model = name;
    }
  }
  // Prefer the session's own cwd; fall back to the lossy directory name
  // only when the log recorded no cwd at all, and even then the fallback
  // is flagged ambiguous rather than presented as a project name.
  const fromCwd = projectKeyFromCwd(acc.cwd);
  const key = fromCwd.ambiguous
    ? projectKeyFromEncodedDir(acc.encodedDir)
    : fromCwd;
  return {
    session_id: acc.session_id,
    cwd: acc.cwd,
    project_key: key.ambiguous ? "" : key.key,
    git_branch: acc.git_branch,
    started_at: acc.startedAt,
    ended_at: acc.endedAt,
    model,
    input_tokens: acc.input,
    cached_tokens: acc.cached,
    cache_write_tokens: acc.cacheWrite,
    output_tokens: acc.output,
    total_tokens: acc.total,
    turns: acc.turns,
    jsonl_path: acc.jsonl_path,
  };
}

interface ScanContext {
  daily: Map<string, Accumulator>;
  hourly: Map<string, UsageHourlyRow>;
  sessions: Map<string, SessionAccumulator>;
  prLinks: PrLink[];
  onLatest: (ts: string) => void;
}

async function scanFile(
  filePath: string,
  encodedDir: string,
  since: Date,
  ctx: ScanContext,
): Promise<void> {
  const fallbackSessionId = filePath.slice(
    filePath.lastIndexOf("/") + 1,
    -".jsonl".length,
  );
  const stream = createReadStream(filePath, { encoding: "utf-8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (line.length === 0) continue;
      // Fast path: only two line kinds matter, and both are rare relative
      // to tool results and user messages. Skipping the JSON.parse on
      // everything else is what keeps a 1.3 GB walk tolerable.
      const isUsage = line.includes('"usage"');
      const isPrLink = line.includes('"pr-link"');
      if (!isUsage && !isPrLink) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // Truncated final write / half-flushed line. Skip it.
        continue;
      }
      if (!isPlainObject(parsed)) continue;

      if (parsed.type === "pr-link") {
        const link = readPrLink(parsed, fallbackSessionId);
        if (link) ctx.prLinks.push(link);
        continue;
      }

      const ts = typeof parsed.timestamp === "string" ? parsed.timestamp : null;
      const message = isPlainObject(parsed.message) ? parsed.message : null;
      const usage =
        message && isPlainObject(message.usage) ? message.usage : null;
      if (!ts || !usage) continue;

      const at = new Date(ts);
      if (Number.isNaN(at.getTime())) continue;
      ctx.onLatest(ts);

      const sessionId =
        typeof parsed.sessionId === "string" && parsed.sessionId.length > 0
          ? parsed.sessionId
          : fallbackSessionId;
      // `message` is non-null here (the `!ts || !usage` guard above
      // returns otherwise), but narrowing doesn't survive the
      // intervening statements — read it off `usage`'s owner explicitly.
      const model = typeof message?.model === "string" ? message.model : "";
      const cwd = typeof parsed.cwd === "string" ? parsed.cwd : "";
      const branch =
        typeof parsed.gitBranch === "string" && parsed.gitBranch.length > 0
          ? parsed.gitBranch
          : null;

      const input = numOr0(usage.input_tokens);
      // Reads and writes stay separate all the way through: a cache READ
      // costs ~10% of input, a cache WRITE costs ~25% MORE than input.
      // Merging them and pricing the total at the read rate understated
      // every long session's API-equivalent value (Codex, PR #8).
      const cached = numOr0(usage.cache_read_input_tokens);
      const cacheWrite = numOr0(usage.cache_creation_input_tokens);
      const output = numOr0(usage.output_tokens);

      accumulateSession(ctx.sessions, {
        sessionId,
        cwd,
        branch,
        at,
        model,
        input,
        cached,
        cacheWrite,
        output,
        filePath,
        encodedDir,
      });

      // Only days at or after the scan window get ledger rows — earlier
      // days are already final in the table and must not be rewritten
      // from a partial read.
      if (at < since) continue;

      const projectKey = projectKeyFromCwd(cwd);
      const key = projectKey.ambiguous ? "" : projectKey.key;
      const day = localDayKey(at);
      const mapKey = `${day} ${model} ${key}`;
      let acc = ctx.daily.get(mapKey);
      if (!acc) {
        acc = {
          row: emptyUsageRow(day, "claude", "cli", model, key),
          sessionIds: new Set(),
        };
        ctx.daily.set(mapKey, acc);
      }
      acc.row.input_tokens += input;
      acc.row.cached_tokens += cached;
      acc.row.cache_write_tokens += cacheWrite;
      acc.row.output_tokens += output;
      // Cache reads and writes are real tokens the window caps count, so
      // they belong in the total — leaving them out would understate a
      // heavy Claude Code day by an order of magnitude.
      acc.row.total_tokens += input + cached + cacheWrite + output;
      acc.row.turns += 1;
      acc.sessionIds.add(sessionId);

      const hour = localHour(at);
      const hourKey = `${day} ${hour}`;
      let hourRow = ctx.hourly.get(hourKey);
      if (!hourRow) {
        hourRow = { day, hour, provider: "claude", turns: 0, events: 0 };
        ctx.hourly.set(hourKey, hourRow);
      }
      hourRow.turns += 1;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

interface TurnInput {
  sessionId: string;
  cwd: string;
  branch: string | null;
  at: Date;
  model: string;
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  filePath: string;
  encodedDir: string;
}

function accumulateSession(
  sessions: Map<string, SessionAccumulator>,
  turn: TurnInput,
): void {
  const seconds = Math.floor(turn.at.getTime() / 1000);
  let acc = sessions.get(turn.sessionId);
  if (!acc) {
    acc = {
      session_id: turn.sessionId,
      cwd: turn.cwd,
      git_branch: turn.branch,
      startedAt: seconds,
      endedAt: seconds,
      modelTurns: new Map(),
      input: 0,
      cached: 0,
      cacheWrite: 0,
      output: 0,
      total: 0,
      turns: 0,
      jsonl_path: turn.filePath,
      encodedDir: turn.encodedDir,
    };
    sessions.set(turn.sessionId, acc);
  }
  if (seconds < acc.startedAt) acc.startedAt = seconds;
  if (seconds > acc.endedAt) acc.endedAt = seconds;
  // Later lines win for cwd/branch: a session that starts before a
  // worktree exists still ends up attributed to where the work happened.
  if (turn.cwd) acc.cwd = turn.cwd;
  if (turn.branch) acc.git_branch = turn.branch;
  if (turn.model) {
    acc.modelTurns.set(turn.model, (acc.modelTurns.get(turn.model) ?? 0) + 1);
  }
  acc.input += turn.input;
  acc.cached += turn.cached;
  acc.cacheWrite += turn.cacheWrite;
  acc.output += turn.output;
  acc.total += turn.input + turn.cached + turn.cacheWrite + turn.output;
  acc.turns += 1;
}

function readPrLink(
  parsed: Record<string, unknown>,
  fallbackSessionId: string,
): PrLink | null {
  const repo =
    typeof parsed.prRepository === "string" ? parsed.prRepository : "";
  const number =
    typeof parsed.prNumber === "number" && Number.isFinite(parsed.prNumber)
      ? parsed.prNumber
      : null;
  if (!repo || number === null) return null;
  const at =
    typeof parsed.timestamp === "string"
      ? Math.floor(new Date(parsed.timestamp).getTime() / 1000)
      : 0;
  return {
    sessionId:
      typeof parsed.sessionId === "string" && parsed.sessionId.length > 0
        ? parsed.sessionId
        : fallbackSessionId,
    prRepository: repo,
    prNumber: number,
    prUrl: typeof parsed.prUrl === "string" ? parsed.prUrl : "",
    at: Number.isFinite(at) ? at : 0,
  };
}

function numOr0(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
