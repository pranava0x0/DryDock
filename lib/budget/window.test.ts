import { describe, expect, it } from "vitest";
import { currentUsageWindow, formatCountdown } from "./window";

describe("currentUsageWindow", () => {
  it("spans the current calendar month with reset at the 1st of next month", () => {
    // Mid-month: 2026-05-16 12:00 local.
    const w = currentUsageWindow(new Date(2026, 4, 16, 12, 0, 0));
    expect(new Date(w.startISO).getFullYear()).toBe(2026);
    expect(new Date(w.startISO).getMonth()).toBe(4); // May
    expect(new Date(w.startISO).getDate()).toBe(1);
    // Reset is the first instant of June.
    expect(new Date(w.endISO).getMonth()).toBe(5);
    expect(new Date(w.endISO).getDate()).toBe(1);
  });

  it("computes elapsed percent through the window", () => {
    // Exactly halfway through a 30-day month (June): start of day 16.
    const w = currentUsageWindow(new Date(2026, 5, 16, 0, 0, 0));
    // 15 of 30 days elapsed = 50%.
    expect(w.elapsedPct).toBeCloseTo(50, 1);
  });

  it("reports 0% at the first instant and ~100% near the end", () => {
    const startW = currentUsageWindow(new Date(2026, 4, 1, 0, 0, 0));
    expect(startW.elapsedPct).toBe(0);
    const endW = currentUsageWindow(new Date(2026, 4, 31, 23, 59, 59));
    expect(endW.elapsedPct).toBeGreaterThan(99);
    expect(endW.elapsedPct).toBeLessThanOrEqual(100);
  });

  it("counts seconds until the next-month reset", () => {
    // 2 days + 0h before June 1 → 2026-05-30 00:00.
    const w = currentUsageWindow(new Date(2026, 4, 30, 0, 0, 0));
    expect(w.secondsUntilReset).toBe(2 * 24 * 60 * 60);
  });

  it("never returns a negative countdown", () => {
    const w = currentUsageWindow(new Date(2026, 4, 31, 23, 59, 59, 999));
    expect(w.secondsUntilReset).toBeGreaterThanOrEqual(0);
  });
});

describe("formatCountdown", () => {
  it.each([
    [8 * 86400 + 3 * 3600, "8d 3h"],
    [3 * 3600 + 12 * 60, "3h 12m"],
    [12 * 60 + 30, "12m"],
    [40, "<1m"],
    [0, "<1m"],
  ])("formats %i seconds as %s", (secs, expected) => {
    expect(formatCountdown(secs)).toBe(expected);
  });
});
