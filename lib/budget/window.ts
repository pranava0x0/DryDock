/**
 * Usage-window math for the header summary widget.
 *
 * The "window" is the current calendar month in the server/user's local
 * timezone — it matches the `monthly` window the provider-usage readers
 * report (claude-usage / codex-usage / gemini-usage), so the tokens shown
 * in the header line up with the per-service cards in Settings. The window
 * resets at the first instant of the next month.
 *
 * These helpers are pure and isomorphic (no node APIs) so the client
 * BudgetWidget can run them directly for a live countdown without a
 * round-trip, and they stay unit-testable.
 */

/** Settings key for the optional, manually-entered API credit balance. */
export const CREDITS_KEY = "credits_usd";

export interface UsageWindow {
  /** First instant of the current month (ISO). */
  startISO: string;
  /** Reset instant — first instant of next month (ISO). */
  endISO: string;
  /** Percent of the window elapsed, 0–100, one decimal. */
  elapsedPct: number;
  /** Whole seconds until the window resets. Never negative. */
  secondsUntilReset: number;
}

export function currentUsageWindow(now: Date = new Date()): UsageWindow {
  const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  // First instant of next month = the reset boundary.
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0);
  const total = end.getTime() - start.getTime();
  const elapsed = Math.min(Math.max(now.getTime() - start.getTime(), 0), total);
  const elapsedPct = Math.round((elapsed / total) * 1000) / 10;
  const secondsUntilReset = Math.max(
    0,
    Math.ceil((end.getTime() - now.getTime()) / 1000),
  );
  return {
    startISO: start.toISOString(),
    endISO: end.toISOString(),
    elapsedPct,
    secondsUntilReset,
  };
}

/**
 * Human-friendly countdown: "8d 3h", "3h 12m", "12m", "<1m". Keeps two
 * units of precision so the header stays compact.
 */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return "<1m";
}
