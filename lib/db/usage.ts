import { getDb } from "./index";

/**
 * The usage ledger (EP-10 Spec A).
 *
 * Grain is one row per (day × provider × surface × model × project_key).
 * Days are LOCAL (see lib/util/day.ts) because every question this table
 * answers — "what did Tuesday look like", "when do I actually work" — is
 * a question about the user's own calendar, not UTC's.
 *
 * ── Why replace-a-range instead of a blind upsert ───────────────────────
 * The plan called for an idempotent UPSERT so partial days self-heal, and
 * the SET-semantics upsert below does exactly that for a *complete*
 * recomputation of a (day, dims) tuple. But a collector run is scoped by
 * an mtime watermark, and within its scope it recomputes whole days from
 * scratch. If a row existed for a dimension that produced no rows this
 * time (a model the user stopped using, a project that got renamed), a
 * pure upsert would leave the stale row behind forever and every total
 * that sums the table would keep counting it.
 *
 * So collectors use `replaceUsageDailyRange`: delete this provider's rows
 * from `fromDay` onward, then insert what was just computed, in one
 * transaction. That's sound precisely because of the mtime pre-filter's
 * guarantee — a file whose mtime predates `fromDay` cannot contain a turn
 * on or after it, so "everything from fromDay onward" really was
 * recomputed in full.
 *
 * `upsertUsageDaily` stays for the import path (EP-15), where a file drop
 * genuinely does carry only some of the dimensions for a day and must
 * merge rather than clear.
 */

export type UsageProvider = "claude" | "codex" | "google";
export type UsageSurface = "cli" | "web" | "import";

export interface UsageDailyRow {
  day: string;
  provider: UsageProvider;
  surface: UsageSurface;
  model: string;
  project_key: string;
  input_tokens: number;
  /** Cache reads — cheap. */
  cached_tokens: number;
  /** Cache writes — dearer than input. Never merge with reads. */
  cache_write_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
  sessions: number;
  turns: number;
  events: number;
}

const COLUMNS = `day, provider, surface, model, project_key,
  input_tokens, cached_tokens, cache_write_tokens, output_tokens,
  reasoning_tokens, total_tokens, sessions, turns, events`;

/** A zeroed row, so accumulators never have to spell out 8 zeros. */
export function emptyUsageRow(
  day: string,
  provider: UsageProvider,
  surface: UsageSurface,
  model = "",
  projectKey = "",
): UsageDailyRow {
  return {
    day,
    provider,
    surface,
    model,
    project_key: projectKey,
    input_tokens: 0,
    cached_tokens: 0,
    cache_write_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    total_tokens: 0,
    sessions: 0,
    turns: 0,
    events: 0,
  };
}

function insertStatement() {
  return getDb().prepare(
    `INSERT INTO usage_daily (${COLUMNS}, updated_at)
     VALUES (@day, @provider, @surface, @model, @project_key,
             @input_tokens, @cached_tokens, @cache_write_tokens,
             @output_tokens, @reasoning_tokens, @total_tokens, @sessions,
             @turns, @events, unixepoch())
     ON CONFLICT(day, provider, surface, model, project_key) DO UPDATE SET
       input_tokens = excluded.input_tokens,
       cached_tokens = excluded.cached_tokens,
       cache_write_tokens = excluded.cache_write_tokens,
       output_tokens = excluded.output_tokens,
       reasoning_tokens = excluded.reasoning_tokens,
       total_tokens = excluded.total_tokens,
       sessions = excluded.sessions,
       turns = excluded.turns,
       events = excluded.events,
       updated_at = unixepoch()`,
  );
}

/**
 * Merge rows into the ledger, SET-semantics per exact primary key.
 * Re-running with identical input is a no-op — that's the idempotency the
 * collectors' partial-day self-healing rests on.
 */
export function upsertUsageDaily(rows: UsageDailyRow[]): number {
  if (rows.length === 0) return 0;
  const db = getDb();
  const stmt = insertStatement();
  const run = db.transaction((batch: UsageDailyRow[]) => {
    for (const row of batch) stmt.run(row);
  });
  run(rows);
  return rows.length;
}

/**
 * Atomically replace one provider+surface's rows from `fromDay` onward.
 *
 * The delete and the insert share a transaction so a crash mid-collect
 * can't leave the ledger emptied — a dashboard reading zero because the
 * writer died halfway is the "confident wrong value" the house rules ban.
 */
export function replaceUsageDailyRange(
  provider: UsageProvider,
  surface: UsageSurface,
  fromDay: string,
  rows: UsageDailyRow[],
): number {
  const db = getDb();
  const del = db.prepare(
    `DELETE FROM usage_daily
      WHERE provider = ? AND surface = ? AND day >= ?`,
  );
  const stmt = insertStatement();
  const run = db.transaction((batch: UsageDailyRow[]) => {
    del.run(provider, surface, fromDay);
    for (const row of batch) stmt.run(row);
  });
  run(rows);
  return rows.length;
}

export interface UsageQuery {
  provider?: UsageProvider;
  /** Inclusive `YYYY-MM-DD`. */
  fromDay?: string;
  /** Inclusive `YYYY-MM-DD`. */
  toDay?: string;
}

function whereFor(q: UsageQuery): { clause: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.provider) {
    where.push("provider = ?");
    params.push(q.provider);
  }
  if (q.fromDay) {
    where.push("day >= ?");
    params.push(q.fromDay);
  }
  if (q.toDay) {
    where.push("day <= ?");
    params.push(q.toDay);
  }
  return {
    clause: where.length ? `WHERE ${where.join(" AND ")}` : "",
    params,
  };
}

export function listUsageDaily(q: UsageQuery = {}): UsageDailyRow[] {
  const { clause, params } = whereFor(q);
  return getDb()
    .prepare(
      `SELECT ${COLUMNS} FROM usage_daily ${clause}
        ORDER BY day ASC, provider ASC, model ASC, project_key ASC`,
    )
    .all(...params) as UsageDailyRow[];
}

export interface UsageTotals {
  input_tokens: number;
  cached_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
  turns: number;
  events: number;
  /**
   * **Do not render this as a session count.** It is the sum of a
   * per-dimension counter, so a session that used two models on one day
   * contributes 2 — the Claude scanner explicitly produces that case.
   * Use `distinctSessionDays()` for a figure a human will read.
   * Retained because it is still the right denominator for per-dimension
   * ratios, where both sides are counted the same way.
   */
  sessions: number;
  days: number;
}

const SUMS = `COALESCE(SUM(input_tokens),0)     AS input_tokens,
  COALESCE(SUM(cached_tokens),0)    AS cached_tokens,
  COALESCE(SUM(cache_write_tokens),0) AS cache_write_tokens,
  COALESCE(SUM(output_tokens),0)    AS output_tokens,
  COALESCE(SUM(reasoning_tokens),0) AS reasoning_tokens,
  COALESCE(SUM(total_tokens),0)     AS total_tokens,
  COALESCE(SUM(turns),0)            AS turns,
  COALESCE(SUM(events),0)           AS events,
  COALESCE(SUM(sessions),0)         AS sessions,
  COUNT(DISTINCT day)               AS days`;

export function usageTotals(q: UsageQuery = {}): UsageTotals {
  const { clause, params } = whereFor(q);
  const row = getDb()
    .prepare(`SELECT ${SUMS} FROM usage_daily ${clause}`)
    .get(...params) as UsageTotals | undefined;
  return (
    row ?? {
      input_tokens: 0,
      cached_tokens: 0,
      cache_write_tokens: 0,
      output_tokens: 0,
      reasoning_tokens: 0,
      total_tokens: 0,
      turns: 0,
      events: 0,
      sessions: 0,
      days: 0,
    }
  );
}

/**
 * Session-days, counted once per (day, provider) rather than summed
 * across ledger rows.
 *
 * The ledger's grain is (day × provider × surface × model × project), and
 * `sessions` lives on every row — so a session that touched two models on
 * one day is stored as 1 twice, and `SUM(sessions)` reports 2. The Usage
 * tab was rendering that sum as "SESSIONS", which over-counted every
 * multi-model day (Codex caught this on PR #8).
 *
 * Taking the MAX within a (day, provider) is the right reduction: every
 * row for that day carries a count of the sessions that contributed to
 * *its* slice, so the largest is the closest available lower bound on
 * how many distinct sessions the day actually had. It cannot exceed the
 * truth, which is the direction to err in.
 *
 * Exact per-session identity is available from `ai_sessions` once EP-11's
 * session store lands; until then this is the honest approximation and
 * is labelled "conversations" rather than a precise count.
 */
export function distinctSessionDays(q: UsageQuery = {}): number {
  const { clause, params } = whereFor(q);
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(per_day), 0) AS n FROM (
         SELECT MAX(sessions) AS per_day
           FROM usage_daily ${clause}
          GROUP BY day, provider
       )`,
    )
    .get(...params) as { n: number } | undefined;
  return row?.n ?? 0;
}

export type UsageDimension = "day" | "model" | "project_key" | "provider";

export interface UsageSlice extends UsageTotals {
  /** The dimension value. `''` means "unknown" — never rendered as a name. */
  key: string;
}

/**
 * Roll the ledger up along one dimension. The dimension name is
 * validated against a closed set rather than interpolated from caller
 * input — this is the only place in the module that builds SQL from a
 * non-parameter, so it stays deliberately narrow.
 */
export function usageBy(
  dimension: UsageDimension,
  q: UsageQuery = {},
): UsageSlice[] {
  const column: Record<UsageDimension, string> = {
    day: "day",
    model: "model",
    project_key: "project_key",
    provider: "provider",
  };
  const col = column[dimension];
  if (!col) throw new Error(`usageBy: unsupported dimension ${dimension}`);

  const { clause, params } = whereFor(q);
  return getDb()
    .prepare(
      `SELECT ${col} AS key, ${SUMS}
         FROM usage_daily ${clause}
        GROUP BY ${col}
        ORDER BY total_tokens DESC, events DESC, key ASC`,
    )
    .all(...params) as UsageSlice[];
}

// ── Hourly rhythm ────────────────────────────────────────────────────────

export interface UsageHourlyRow {
  day: string;
  hour: number;
  provider: UsageProvider;
  turns: number;
  events: number;
}

/**
 * Replace one provider's hourly counts from `fromDay` onward, in the same
 * transaction shape (and for the same reason) as the daily ledger.
 */
export function replaceUsageHourlyRange(
  provider: UsageProvider,
  fromDay: string,
  rows: UsageHourlyRow[],
): number {
  const db = getDb();
  const del = db.prepare(
    `DELETE FROM usage_hourly WHERE provider = ? AND day >= ?`,
  );
  const ins = db.prepare(
    `INSERT INTO usage_hourly (day, hour, provider, turns, events)
     VALUES (@day, @hour, @provider, @turns, @events)
     ON CONFLICT(day, hour, provider) DO UPDATE SET
       turns = excluded.turns,
       events = excluded.events`,
  );
  const run = db.transaction((batch: UsageHourlyRow[]) => {
    del.run(provider, fromDay);
    for (const row of batch) ins.run(row);
  });
  run(rows);
  return rows.length;
}

export interface RhythmCell {
  /** 0 = Sunday, matching Date#getDay. */
  weekday: number;
  hour: number;
  turns: number;
  events: number;
}

/**
 * Turns and events bucketed by (weekday, hour) over a day range.
 *
 * Weekday is computed in SQLite from `day` with `strftime('%w')`. `day` is
 * already a local calendar date, so this is a pure string operation — no
 * timezone conversion happens here, and none should: the bucketing was
 * settled when the row was written.
 */
export function usageRhythm(q: UsageQuery = {}): RhythmCell[] {
  const { clause, params } = whereFor(q);
  return getDb()
    .prepare(
      `SELECT CAST(strftime('%w', day) AS INTEGER) AS weekday,
              hour,
              COALESCE(SUM(turns), 0)  AS turns,
              COALESCE(SUM(events), 0) AS events
         FROM usage_hourly ${clause}
        GROUP BY weekday, hour
        ORDER BY weekday ASC, hour ASC`,
    )
    .all(...params) as RhythmCell[];
}

/** Newest day present for a provider, or null when it has no rows yet. */
export function latestUsageDay(provider?: UsageProvider): string | null {
  const { clause, params } = whereFor({ provider });
  const row = getDb()
    .prepare(`SELECT MAX(day) AS day FROM usage_daily ${clause}`)
    .get(...params) as { day: string | null } | undefined;
  return row?.day ?? null;
}
