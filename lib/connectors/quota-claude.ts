import { promises as fs } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Claude quota signal from `~/.claude/stats-cache.json` (EP-10 Spec D).
 *
 * ── What this is and firmly is not ──────────────────────────────────────
 * The stats cache is Claude Code's own pre-aggregated store — the thing
 * behind `/usage`, and notably exempt from the 30-day session-log sweep,
 * so it can carry totals whose source JSONLs are already gone.
 *
 * Its schema is **undocumented**, so everything here is a defensive
 * probe: known-ish field names are looked for, anything unrecognized is
 * ignored, and a parse failure returns `unavailable` rather than
 * throwing or — much worse — zeros.
 *
 * We do **not** call the undocumented usage endpoint the CLI itself
 * polls for cap percentages. Anthropic acknowledges it but doesn't
 * document it, and hitting reverse-engineered paths from an automated
 * process is exactly the ToS line EP-15 draws. So when the cache has no
 * percentage we report window *consumption* and reset times and leave
 * cap-% to a manual check — an honest blank beats an invented number.
 *
 * ── Verified state on this machine ──────────────────────────────────────
 * `~/.claude/stats-cache.json` does NOT exist here, despite 1,673 session
 * logs. The plan assumed it would. So this returns `unavailable` today
 * and the Usage tab shows token consumption from the ledger instead,
 * with cap-% blank. If a future Claude Code version writes the file, this
 * starts working with no code change.
 */

export interface ClaudeQuotaResult {
  status: "ok" | "unavailable";
  reason: string | null;
  /**
   * Percentage of the weekly window consumed, when the cache states one.
   * Null is the expected answer, not a bug — see above.
   */
  weeklyUsedPct: number | null;
  /** Unix seconds, when stated. */
  weeklyResetsAt: number | null;
  fiveHourUsedPct: number | null;
  fiveHourResetsAt: number | null;
  /** Lifetime totals, when present. Useful even without percentages. */
  totalTokens: number | null;
  totalCostUsd: number | null;
}

function unavailable(reason: string): ClaudeQuotaResult {
  return {
    status: "unavailable",
    reason,
    weeklyUsedPct: null,
    weeklyResetsAt: null,
    fiveHourUsedPct: null,
    fiveHourResetsAt: null,
    totalTokens: null,
    totalCostUsd: null,
  };
}

export async function readClaudeQuota(
  path: string = join(homedir(), ".claude", "stats-cache.json"),
): Promise<ClaudeQuotaResult> {
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch {
    return unavailable(
      "no ~/.claude/stats-cache.json — this Claude Code build does not write one",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return unavailable("stats-cache.json is not valid JSON");
  }
  return parseStatsCache(parsed);
}

/**
 * Pull whatever we recognize out of the cache.
 *
 * Exported so fixtures can pin the behaviour against several plausible
 * shapes: since the real schema is undocumented, "tolerates a shape we
 * didn't anticipate" is the property actually worth testing.
 */
export function parseStatsCache(parsed: unknown): ClaudeQuotaResult {
  if (!isPlainObject(parsed)) {
    return unavailable("stats-cache.json did not contain an object");
  }

  const weekly = firstObject(parsed, [
    "weekly",
    "week",
    "weeklyLimit",
    "weekly_limit",
  ]);
  const fiveHour = firstObject(parsed, [
    "fiveHour",
    "five_hour",
    "session",
    "sessionLimit",
  ]);
  const totals = firstObject(parsed, ["totals", "total", "lifetime"]) ?? parsed;

  const result: ClaudeQuotaResult = {
    status: "ok",
    reason: null,
    weeklyUsedPct: pct(weekly),
    weeklyResetsAt: resetsAt(weekly),
    fiveHourUsedPct: pct(fiveHour),
    fiveHourResetsAt: resetsAt(fiveHour),
    totalTokens: firstNumber(totals, [
      "totalTokens",
      "total_tokens",
      "tokens",
    ]),
    totalCostUsd: firstNumber(totals, [
      "totalCostUsd",
      "total_cost_usd",
      "costUsd",
      "cost",
    ]),
  };

  const gotSomething =
    result.weeklyUsedPct !== null ||
    result.fiveHourUsedPct !== null ||
    result.totalTokens !== null ||
    result.totalCostUsd !== null;
  if (!gotSomething) {
    // The file exists but holds nothing we understand. Say that plainly:
    // an "ok" result full of nulls would look like a working collector
    // reporting no usage.
    return unavailable(
      "stats-cache.json exists but its schema has changed — no recognizable usage fields",
    );
  }
  return result;
}

function pct(source: Record<string, unknown> | null): number | null {
  const value = firstNumber(source, [
    "usedPercent",
    "used_percent",
    "utilization",
    "percentUsed",
    "percent_used",
  ]);
  if (value === null) return null;
  // Accept either 0–1 or 0–100 and normalize to a percentage. A 0.62 read
  // as 0.62% would show a nearly-empty bar on a week that's two-thirds
  // gone; the ambiguity is unavoidable without a documented schema, and
  // fractions above 1 are unambiguous.
  return value > 1 ? value : value * 100;
}

function resetsAt(source: Record<string, unknown> | null): number | null {
  const value = firstNumber(source, [
    "resetsAt",
    "resets_at",
    "resetAt",
    "reset_at",
  ]);
  if (value === null) return null;
  return value > 100_000_000_000 ? Math.floor(value / 1000) : value;
}

function firstObject(
  source: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> | null {
  for (const key of keys) {
    const value = source[key];
    if (isPlainObject(value)) return value;
  }
  return null;
}

function firstNumber(
  source: Record<string, unknown> | null,
  keys: string[],
): number | null {
  if (!source) return null;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
