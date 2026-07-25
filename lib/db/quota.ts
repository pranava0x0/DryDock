import { nanoid } from "nanoid";
import { getDb } from "./index";
import type { UsageProvider } from "./usage";

/**
 * Quota snapshots (EP-10 Spec D): point-in-time "% of this window
 * consumed" readings.
 *
 * ── Why token sums can't answer this ────────────────────────────────────
 * The caps gate on a *percentage*, and none of the providers publishes
 * the denominator. Codex additionally weights by reasoning effort, so
 * even a perfect token count wouldn't reconstruct its number. So a
 * percentage only ever comes from a source that computed it — a
 * sanctioned local surface, or the user reading their own account page —
 * and `used_pct` is nullable precisely so "we don't know" stays
 * expressible instead of collapsing to 0%.
 *
 * Snapshots are append-only. Keeping the history means the digest can say
 * "85% and climbing" rather than just "85%", and it costs a few rows a
 * day.
 */

export type QuotaWindow = "5h" | "week" | "week_sonnet";
export type QuotaSource = "app-server" | "stats-cache" | "manual" | "browser";

export const QUOTA_WINDOWS: readonly QuotaWindow[] = [
  "5h",
  "week",
  "week_sonnet",
] as const;

export interface QuotaSnapshot {
  id: string;
  provider: UsageProvider;
  window: QuotaWindow;
  used_pct: number | null;
  resets_at: number | null;
  source: QuotaSource;
  captured_at: number;
}

export interface NewQuotaSnapshot {
  provider: UsageProvider;
  window: QuotaWindow;
  used_pct?: number | null;
  resets_at?: number | null;
  source: QuotaSource;
  captured_at?: number;
}

// `window` is a SQLite keyword (window functions), so it is quoted in
// every query. Kept as the column name anyway because it's the word the
// providers themselves use for these periods.
const COLUMNS = `id, provider, "window", used_pct, resets_at, source, captured_at`;

export function recordQuotaSnapshot(input: NewQuotaSnapshot): QuotaSnapshot {
  const id = nanoid();
  const capturedAt = input.captured_at ?? Math.floor(Date.now() / 1000);
  getDb()
    .prepare(
      `INSERT INTO quota_snapshots
         (id, provider, "window", used_pct, resets_at, source, captured_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.provider,
      input.window,
      input.used_pct ?? null,
      input.resets_at ?? null,
      input.source,
      capturedAt,
    );
  const row = getQuotaSnapshot(id);
  if (!row) {
    throw new Error(`recordQuotaSnapshot: row not found after insert (${id})`);
  }
  return row;
}

export function getQuotaSnapshot(id: string): QuotaSnapshot | null {
  const row = getDb()
    .prepare(`SELECT ${COLUMNS} FROM quota_snapshots WHERE id = ?`)
    .get(id) as QuotaSnapshot | undefined;
  return row ?? null;
}

/**
 * The most recent snapshot per (provider, window).
 *
 * Callers must render `captured_at` alongside the value — a quota
 * reading is only meaningful with its age, and a two-day-old "58%"
 * presented as current is worse than showing nothing. `latestQuotaAge`
 * exists so that's a one-liner.
 */
export function latestQuotaSnapshots(
  provider?: UsageProvider,
): QuotaSnapshot[] {
  const where = provider ? "WHERE provider = ?" : "";
  const params = provider ? [provider] : [];
  // `captured_at` is unixepoch() seconds, so two snapshots written in the
  // same second tie — the rowid tiebreak is the same fix the runs table
  // needed for follow-ups (DD-010). Without it "latest" is a coin flip.
  return getDb()
    .prepare(
      `SELECT ${COLUMNS} FROM (
         SELECT id, provider, "window", used_pct, resets_at, source,
                captured_at,
                ROW_NUMBER() OVER (
                  PARTITION BY provider, "window"
                  ORDER BY captured_at DESC, rowid DESC
                ) AS rn
           FROM quota_snapshots
           ${where}
       )
        WHERE rn = 1
        ORDER BY provider ASC, "window" ASC`,
    )
    .all(...params) as QuotaSnapshot[];
}

/** Seconds since a snapshot was captured. */
export function quotaAgeSeconds(
  snapshot: QuotaSnapshot,
  now: number = Math.floor(Date.now() / 1000),
): number {
  return Math.max(0, now - snapshot.captured_at);
}

/** History for one (provider, window), newest first. */
export function quotaHistory(
  provider: UsageProvider,
  window: QuotaWindow,
  limit = 50,
): QuotaSnapshot[] {
  return getDb()
    .prepare(
      `SELECT ${COLUMNS} FROM quota_snapshots
        WHERE provider = ? AND "window" = ?
        ORDER BY captured_at DESC, rowid DESC
        LIMIT ?`,
    )
    .all(provider, window, limit) as QuotaSnapshot[];
}
