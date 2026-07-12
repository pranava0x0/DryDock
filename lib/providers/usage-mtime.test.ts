import { describe, expect, it } from "vitest";
import {
  mayContainRecentTurns,
  MTIME_SAFETY_MARGIN_MS,
  widestCutoff,
} from "./usage-mtime";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("widestCutoff", () => {
  it("returns the earliest cutoff (the one admitting the most files)", () => {
    const a = new Date("2026-07-01T00:00:00Z");
    const b = new Date("2026-07-05T00:00:00Z");
    expect(widestCutoff(a, b).toISOString()).toBe(a.toISOString());
    expect(widestCutoff(b, a).toISOString()).toBe(a.toISOString());
  });
});

describe("mayContainRecentTurns", () => {
  const cutoff = new Date("2026-07-01T00:00:00Z");
  const stat = (mtimeMs: number) => async () => ({ mtimeMs });

  it("keeps a file modified after the cutoff", async () => {
    const mtime = new Date("2026-07-08T00:00:00Z").getTime();
    expect(await mayContainRecentTurns("f", cutoff, stat(mtime))).toBe(true);
  });

  it("skips a file modified well before the cutoff", async () => {
    const mtime = new Date("2026-06-01T00:00:00Z").getTime();
    expect(await mayContainRecentTurns("f", cutoff, stat(mtime))).toBe(false);
  });

  it("keeps a file inside the safety margin below the cutoff", async () => {
    // 6h before the cutoff is within the 12h margin — must not be skipped.
    const mtime = cutoff.getTime() - 6 * HOUR;
    expect(await mayContainRecentTurns("f", cutoff, stat(mtime))).toBe(true);
  });

  it("skips only once past the full margin", async () => {
    const justInside = cutoff.getTime() - (MTIME_SAFETY_MARGIN_MS - HOUR);
    const justOutside = cutoff.getTime() - (MTIME_SAFETY_MARGIN_MS + HOUR);
    expect(await mayContainRecentTurns("f", cutoff, stat(justInside))).toBe(true);
    expect(await mayContainRecentTurns("f", cutoff, stat(justOutside))).toBe(
      false,
    );
  });

  it("fails open (keeps the file) when stat throws", async () => {
    const throwing = async () => {
      throw new Error("ENOENT");
    };
    expect(await mayContainRecentTurns("f", cutoff, throwing)).toBe(true);
  });

  it("a month-old file is skipped for a start-of-month cutoff", async () => {
    const now = new Date("2026-07-12T00:00:00Z");
    const monthly = new Date(Date.UTC(2026, 6, 1));
    const weekly = new Date(now.getTime() - 7 * DAY);
    const skipBefore = widestCutoff(monthly, weekly);
    const old = new Date("2026-06-05T00:00:00Z").getTime();
    expect(await mayContainRecentTurns("f", skipBefore, stat(old))).toBe(false);
  });
});
