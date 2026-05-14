import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetDbForTests, getDb } from "../db";
import { createProject } from "../db/projects";
import { createTask } from "../db/tasks";
import { completeRun, createRun } from "../db/runs";
import { getSetting, setSetting } from "../db/settings";
import {
  BUDGET_KEY,
  clearAlertedThreshold,
  getBudgetRollup,
  recordAlertedThreshold,
  setMonthlyBudget,
  thresholdFor,
} from "./rollup";

beforeEach(() => {
  _resetDbForTests();
  const dir = mkdtempSync(join(tmpdir(), "drydock-budget-"));
  process.env.DRYDOCK_DB_PATH = join(dir, "budget.db");
  getDb();
});

/** Insert a completed run with a specific started_at + cost so we can
 *  simulate "this month's spend." */
function seedRun(costUsd: number, startedAtSec: number): void {
  const p = createProject({ name: "P", path: "/tmp/p" });
  const t = createTask({
    project_id: p.id,
    title: "t",
    description: "x",
  });
  const r = createRun(t.id, "claude");
  // Backdate started_at to the target second.
  getDb()
    .prepare("UPDATE runs SET started_at = ? WHERE id = ?")
    .run(startedAtSec, r.id);
  completeRun(r.id, {
    status: "success",
    output: "ok",
    cost_usd: costUsd,
    tokens_in: 0,
    tokens_out: 0,
  });
}

describe("thresholdFor", () => {
  it("returns null below 50", () => {
    expect(thresholdFor(0)).toBeNull();
    expect(thresholdFor(49.9)).toBeNull();
  });
  it("returns the highest reached threshold", () => {
    expect(thresholdFor(50)).toBe(50);
    expect(thresholdFor(79)).toBe(50);
    expect(thresholdFor(80)).toBe(80);
    expect(thresholdFor(99.9)).toBe(80);
    expect(thresholdFor(100)).toBe(100);
    expect(thresholdFor(250)).toBe(100);
  });
});

describe("getBudgetRollup", () => {
  it("returns null budget + zero spend on a fresh DB", () => {
    const r = getBudgetRollup();
    expect(r.budgetUsd).toBeNull();
    expect(r.spentUsd).toBe(0);
    expect(r.remainingUsd).toBeNull();
    expect(r.percentUsed).toBeNull();
    expect(r.thresholdReached).toBeNull();
  });

  it("rolls up only runs in the current calendar month", () => {
    setMonthlyBudget(100);
    const now = new Date();
    // This month, mid-month.
    const thisMonth = new Date(now.getFullYear(), now.getMonth(), 15, 12, 0, 0);
    // Two months ago — should NOT count.
    const oldMonth = new Date(
      now.getFullYear(),
      now.getMonth() - 2,
      15,
      12,
      0,
      0,
    );
    seedRun(30, Math.floor(thisMonth.getTime() / 1000));
    seedRun(20, Math.floor(thisMonth.getTime() / 1000));
    seedRun(999, Math.floor(oldMonth.getTime() / 1000)); // old, ignored

    const r = getBudgetRollup();
    expect(r.budgetUsd).toBe(100);
    expect(r.spentUsd).toBe(50);
    expect(r.remainingUsd).toBe(50);
    expect(r.percentUsed).toBe(50);
    expect(r.thresholdReached).toBe(50);
  });

  it("flags 100%+ as thresholdReached=100 and a negative remainingUsd", () => {
    setMonthlyBudget(10);
    const now = new Date();
    const thisMonth = new Date(now.getFullYear(), now.getMonth(), 15, 12, 0, 0);
    seedRun(12.5, Math.floor(thisMonth.getTime() / 1000));
    const r = getBudgetRollup();
    expect(r.percentUsed).toBe(125);
    expect(r.thresholdReached).toBe(100);
    expect(r.remainingUsd).toBe(-2.5);
  });

  it("handles a zero budget gracefully (percentUsed null, no divide-by-zero)", () => {
    setMonthlyBudget(0);
    const now = new Date();
    const thisMonth = new Date(now.getFullYear(), now.getMonth(), 15, 12, 0, 0);
    seedRun(5, Math.floor(thisMonth.getTime() / 1000));
    const r = getBudgetRollup();
    // budget is 0 — the rollup must not crash; percentUsed stays null.
    expect(r.percentUsed).toBeNull();
    expect(r.thresholdReached).toBeNull();
    expect(r.spentUsd).toBe(5);
  });

  it("setMonthlyBudget(null) clears the value (UI shows 'set' chip)", () => {
    setMonthlyBudget(50);
    expect(getSetting(BUDGET_KEY)).toBe("50");
    setMonthlyBudget(null);
    expect(getSetting(BUDGET_KEY)).toBe("");
    expect(getBudgetRollup().budgetUsd).toBeNull();
  });

  it("tracks lastAlertedPct via the helpers", () => {
    recordAlertedThreshold(80);
    expect(getBudgetRollup().lastAlertedPct).toBe(80);
    clearAlertedThreshold();
    expect(getBudgetRollup().lastAlertedPct).toBeNull();
  });
});

describe("settings store", () => {
  it("upserts on conflict so setSetting is idempotent", () => {
    setSetting("k", "v1");
    setSetting("k", "v2");
    expect(getSetting("k")).toBe("v2");
  });
});
