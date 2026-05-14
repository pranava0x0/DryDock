import { getDb } from "../db";
import { getNumberSetting, setSetting } from "../db/settings";

export const BUDGET_KEY = "monthly_budget_usd";
export const LAST_ALERT_KEY = "last_budget_alert_pct";

/** Alert thresholds (percent of budget). Crossing one of these triggers a
 * push/banner exactly once per calendar month. Ordered low→high so the
 * threshold-detection logic can pick the most-recently-crossed band. */
export const ALERT_THRESHOLDS = [50, 80, 100] as const;

export interface BudgetRollup {
  /** ISO date for the first second of the current calendar month. */
  periodStart: string;
  /** ISO date for the last second of the current calendar month. */
  periodEnd: string;
  /** Monthly budget in USD. `null` = budget not yet configured. */
  budgetUsd: number | null;
  /** Sum of runs.cost_usd for runs started in the current month. */
  spentUsd: number;
  /** `budget - spent`, or null if budget is unset. May go negative. */
  remainingUsd: number | null;
  /** spent / budget * 100, rounded to 1 decimal. Null if budget is unset. */
  percentUsed: number | null;
  /** Highest threshold (50/80/100) that's been crossed this period. */
  thresholdReached: 50 | 80 | 100 | null;
  /** Last threshold the UI already alerted on (so we don't double-alert). */
  lastAlertedPct: number | null;
}

/**
 * Compute the [start, end] of the current calendar month in unix seconds.
 * We use the server's local timezone — the user explicitly runs this on
 * their Mac so "month" matches their calendar, not UTC.
 */
function currentMonthRange(now: Date = new Date()): {
  startSec: number;
  endSec: number;
  startISO: string;
  endISO: string;
} {
  const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  // Last second of the month: day 0 of next month = last day of current.
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  return {
    startSec: Math.floor(start.getTime() / 1000),
    endSec: Math.floor(end.getTime() / 1000),
    startISO: start.toISOString(),
    endISO: end.toISOString(),
  };
}

/**
 * Pick the highest threshold that pct has crossed. Returns null when pct
 * is below the lowest threshold (no alert needed yet).
 */
export function thresholdFor(pct: number): 50 | 80 | 100 | null {
  if (pct >= 100) return 100;
  if (pct >= 80) return 80;
  if (pct >= 50) return 50;
  return null;
}

/**
 * Sum every `cost_usd` from runs that started in the given window.
 * `cost_usd` is null for gemini runs and for claude runs before Phase 3 —
 * those are treated as 0 (no cost reported).
 */
function spentInWindow(startSec: number, endSec: number): number {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total
       FROM runs
       WHERE started_at >= ? AND started_at <= ?`,
    )
    .get(startSec, endSec) as { total: number };
  return row.total ?? 0;
}

export function getBudgetRollup(now: Date = new Date()): BudgetRollup {
  const { startSec, endSec, startISO, endISO } = currentMonthRange(now);
  const budgetUsd = getNumberSetting(BUDGET_KEY);
  const spentUsd = spentInWindow(startSec, endSec);
  const remainingUsd = budgetUsd === null ? null : budgetUsd - spentUsd;
  const percentUsed =
    budgetUsd !== null && budgetUsd > 0
      ? Math.round((spentUsd / budgetUsd) * 1000) / 10
      : null;
  const thresholdReached =
    percentUsed === null ? null : thresholdFor(percentUsed);
  const lastAlertedPct = getNumberSetting(LAST_ALERT_KEY);

  return {
    periodStart: startISO,
    periodEnd: endISO,
    budgetUsd,
    spentUsd: Math.round(spentUsd * 10000) / 10000,
    remainingUsd:
      remainingUsd === null ? null : Math.round(remainingUsd * 10000) / 10000,
    percentUsed,
    thresholdReached,
    lastAlertedPct,
  };
}

export function setMonthlyBudget(budgetUsd: number | null): void {
  if (budgetUsd === null) {
    setSetting(BUDGET_KEY, "");
    return;
  }
  setSetting(BUDGET_KEY, String(budgetUsd));
}

/**
 * Record that the UI has shown the user the alert for `pct`. Called from
 * the client once per crossing so we don't repeatedly notify on every
 * page load while the user is still over a threshold.
 */
export function recordAlertedThreshold(pct: number): void {
  setSetting(LAST_ALERT_KEY, String(pct));
}

/**
 * Reset the "last alerted" pointer. Used at the start of each calendar
 * month so the first crossing of a new period fires a fresh alert.
 */
export function clearAlertedThreshold(): void {
  setSetting(LAST_ALERT_KEY, "");
}
