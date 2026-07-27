/**
 * Local-calendar day keys for the usage ledger.
 *
 * Every provider writes UTC ISO timestamps, but "how much did I use
 * Claude on Tuesday" is a question about the user's own calendar. A turn
 * at 2026-07-21T02:00:00Z is 7pm Monday in Los Angeles — bucketing it
 * into Tuesday would put the user's evening work on the wrong day and
 * make the hour-of-day heatmap (the "when do I actually work" card) point
 * at the wrong hours entirely.
 *
 * So: the ledger's `day` column is LOCAL, and every conversion goes
 * through here rather than through `toISOString().slice(0, 10)`, which is
 * the UTC answer wearing a local-looking costume.
 */

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `YYYY-MM-DD` in the host's local timezone. */
export function localDayKey(at: Date): string {
  const y = at.getFullYear();
  const m = String(at.getMonth() + 1).padStart(2, "0");
  const d = String(at.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Local hour-of-day, 0–23. Powers the rhythm heatmap. */
export function localHour(at: Date): number {
  return at.getHours();
}

/** Local weekday, 0 = Sunday. Powers the rhythm heatmap's other axis. */
export function localWeekday(at: Date): number {
  return at.getDay();
}

/**
 * The day key `n` days before `from` (local). Negative `n` moves forward.
 * Uses date arithmetic rather than millisecond subtraction so DST
 * transitions — where a local day is 23 or 25 hours long — don't skip or
 * repeat a day.
 */
export function dayKeyOffset(from: Date, n: number): string {
  const shifted = new Date(
    from.getFullYear(),
    from.getMonth(),
    from.getDate() - n,
  );
  return localDayKey(shifted);
}

/**
 * Every day key from `startDay` to `endDay` inclusive, ascending. Used to
 * render dense charts — a day with no usage must appear as an explicit
 * zero-height bar, not as a gap the eye reads as "no chart here".
 */
export function dayKeyRange(startDay: string, endDay: string): string[] {
  const start = parseDayKey(startDay);
  const end = parseDayKey(endDay);
  if (!start || !end || start > end) return [];
  const out: string[] = [];
  const cursor = new Date(start);
  // Bounded so a malformed input can't spin: ~20 years of days.
  for (let i = 0; i < 7500 && cursor <= end; i += 1) {
    out.push(localDayKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

/** Local midnight for a `YYYY-MM-DD` key, or null if it doesn't parse. */
export function parseDayKey(day: string): Date | null {
  const match = typeof day === "string" ? day.match(DAY_KEY) : null;
  if (!match) return null;
  const parsed = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
  );
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
