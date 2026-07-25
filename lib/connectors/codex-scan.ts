import { createReadStream } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { mayContainRecentTurns } from "../providers/usage-mtime";
import { collectRolloutFiles } from "../providers/codex-usage";
import { projectKeyFromCwd } from "../providers/claude-projects";
import { localDayKey } from "../util/day";
import { emptyUsageRow, type UsageDailyRow } from "../db/usage";

/**
 * Per-day / per-model / per-project scan of the Codex CLI's rollout logs,
 * across both `~/.codex/sessions` and the flat `~/.codex/archived_sessions`
 * (see codex-usage.ts for why the archive matters).
 *
 * ── The model is NOT static ─────────────────────────────────────────────
 * The plan assumed Codex usage couldn't be split by model. It can: every
 * `turn_context` event carries `payload.model` (`gpt-5.6-sol` on this
 * machine) and `payload.cwd`, and those events precede the `token_count`
 * events for the turns they configure. So we carry the most recent
 * `turn_context` forward as the context for subsequent turns — which is
 * exactly what it is — and get a real model mix instead of one grey bar.
 * A rollout that never emits one (older CLI versions) yields `''`, which
 * renders as "unknown" rather than being backfilled with a guess.
 *
 * Token accounting matches the window reader: sum `last_token_usage` (the
 * per-turn delta), never `total_token_usage` (cumulative — summing it
 * would multiply a long session by its own turn count).
 */

export interface CodexScanResult {
  daily: UsageDailyRow[];
  filesScanned: number;
  latestTurnAt: string | null;
  /** True when neither the sessions root nor the archive exists. */
  rootMissing: boolean;
}

interface Accumulator {
  row: UsageDailyRow;
  sessionKeys: Set<string>;
}

export async function scanCodexSessions(
  rootDir: string = join(homedir(), ".codex", "sessions"),
  since: Date = new Date(0),
): Promise<CodexScanResult> {
  const files = await collectRolloutFiles(rootDir);
  if (files.length === 0) {
    return {
      daily: [],
      filesScanned: 0,
      latestTurnAt: null,
      rootMissing: true,
    };
  }

  const daily = new Map<string, Accumulator>();
  let filesScanned = 0;
  let latestTurnAt: string | null = null;

  for (const { path, sessionKey } of files) {
    if (!(await mayContainRecentTurns(path, since))) continue;
    filesScanned += 1;
    await scanRollout(path, sessionKey, since, daily, (ts) => {
      if (latestTurnAt === null || ts > latestTurnAt) latestTurnAt = ts;
    });
  }

  for (const acc of daily.values()) acc.row.sessions = acc.sessionKeys.size;

  return {
    daily: [...daily.values()].map((a) => a.row),
    filesScanned,
    latestTurnAt,
    rootMissing: false,
  };
}

async function scanRollout(
  filePath: string,
  sessionKey: string,
  since: Date,
  daily: Map<string, Accumulator>,
  onLatest: (ts: string) => void,
): Promise<void> {
  const stream = createReadStream(filePath, { encoding: "utf-8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  // Carried forward across turns — `turn_context` and `session_meta`
  // describe the configuration the *following* token_count events were
  // produced under.
  let model = "";
  let cwd = "";

  try {
    for await (const line of rl) {
      if (line.length === 0) continue;
      const isToken = line.includes("token_count");
      const isContext =
        line.includes("turn_context") || line.includes("session_meta");
      if (!isToken && !isContext) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isPlainObject(parsed)) continue;
      const payload = isPlainObject(parsed.payload) ? parsed.payload : parsed;

      if (parsed.type === "turn_context" || parsed.type === "session_meta") {
        if (typeof payload.model === "string" && payload.model.length > 0) {
          model = payload.model;
        }
        if (typeof payload.cwd === "string" && payload.cwd.length > 0) {
          cwd = payload.cwd;
        }
        continue;
      }

      const turn = extractTurn(payload);
      if (!turn) continue;
      const ts = extractTimestamp(parsed);
      if (!ts) continue;
      const at = new Date(ts);
      if (Number.isNaN(at.getTime())) continue;

      onLatest(ts);
      if (at < since) continue;

      const projectKey = projectKeyFromCwd(cwd);
      const key = projectKey.ambiguous ? "" : projectKey.key;
      const day = localDayKey(at);
      const mapKey = `${day} ${model} ${key}`;
      let acc = daily.get(mapKey);
      if (!acc) {
        acc = {
          row: emptyUsageRow(day, "codex", "cli", model, key),
          sessionKeys: new Set(),
        };
        daily.set(mapKey, acc);
      }
      acc.row.input_tokens += turn.input;
      acc.row.cached_tokens += turn.cached;
      acc.row.output_tokens += turn.output;
      acc.row.reasoning_tokens += turn.reasoning;
      // Codex reports its own `total_tokens` per turn; trust it rather
      // than re-deriving, since its definition of what counts toward the
      // cap (reasoning tokens especially) is the provider's to make.
      acc.row.total_tokens += turn.total;
      acc.row.turns += 1;
      acc.sessionKeys.add(sessionKey);
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

interface CodexTurn {
  input: number;
  cached: number;
  output: number;
  reasoning: number;
  total: number;
}

function extractTurn(payload: Record<string, unknown>): CodexTurn | null {
  if (payload.type !== "token_count") return null;
  const info = isPlainObject(payload.info) ? payload.info : null;
  if (!info) return null;
  const usage = isPlainObject(info.last_token_usage)
    ? info.last_token_usage
    : null;
  if (!usage) return null;
  return {
    input: numOr0(usage.input_tokens),
    cached: numOr0(usage.cached_input_tokens),
    output: numOr0(usage.output_tokens),
    reasoning: numOr0(usage.reasoning_output_tokens),
    total: numOr0(usage.total_tokens),
  };
}

function extractTimestamp(parsed: Record<string, unknown>): string | null {
  if (typeof parsed.timestamp === "string") return parsed.timestamp;
  if (
    isPlainObject(parsed.payload) &&
    typeof parsed.payload.timestamp === "string"
  ) {
    return parsed.payload.timestamp;
  }
  return null;
}

function numOr0(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
