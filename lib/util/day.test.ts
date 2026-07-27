import { describe, expect, it } from "vitest";
import {
  dayKeyOffset,
  dayKeyRange,
  localDayKey,
  localHour,
  localWeekday,
  parseDayKey,
} from "./day";

describe("localDayKey", () => {
  it("uses the LOCAL calendar, not UTC", () => {
    // The bug this guards: `toISOString().slice(0,10)` is the UTC answer.
    // Construct a local time explicitly and assert the key matches the
    // local date regardless of what UTC thinks — in a negative-offset
    // timezone a 19:00 local turn is already "tomorrow" in UTC, and
    // bucketing it there puts the user's evening on the wrong day.
    const evening = new Date(2026, 6, 20, 19, 30, 0); // 2026-07-20 19:30 local
    expect(localDayKey(evening)).toBe("2026-07-20");
  });

  it("zero-pads month and day", () => {
    expect(localDayKey(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});

describe("localHour / localWeekday", () => {
  it("reads local wall-clock fields", () => {
    const at = new Date(2026, 6, 20, 23, 15); // a Monday
    expect(localHour(at)).toBe(23);
    expect(localWeekday(at)).toBe(1);
  });
});

describe("dayKeyOffset", () => {
  it("walks back whole calendar days", () => {
    const from = new Date(2026, 6, 20, 12, 0);
    expect(dayKeyOffset(from, 0)).toBe("2026-07-20");
    expect(dayKeyOffset(from, 1)).toBe("2026-07-19");
    expect(dayKeyOffset(from, 20)).toBe("2026-06-30");
  });

  it("moves forward for a negative offset", () => {
    expect(dayKeyOffset(new Date(2026, 6, 20, 12, 0), -1)).toBe("2026-07-21");
  });

  it("crosses a month and a year boundary", () => {
    expect(dayKeyOffset(new Date(2026, 0, 1, 12, 0), 1)).toBe("2025-12-31");
  });

  it("survives a DST transition without skipping or repeating a day", () => {
    // Date arithmetic, not millisecond subtraction: a local day is 23 or
    // 25 hours long across a DST boundary, so `now - n*86400000` lands on
    // the wrong side of midnight and either drops a day or emits one
    // twice. Spring-forward Sunday in US timezones is 2026-03-08.
    const after = new Date(2026, 2, 10, 12, 0);
    expect(dayKeyOffset(after, 1)).toBe("2026-03-09");
    expect(dayKeyOffset(after, 2)).toBe("2026-03-08");
    expect(dayKeyOffset(after, 3)).toBe("2026-03-07");
  });
});

describe("dayKeyRange", () => {
  it("is inclusive at both ends and ascending", () => {
    expect(dayKeyRange("2026-07-19", "2026-07-22")).toEqual([
      "2026-07-19",
      "2026-07-20",
      "2026-07-21",
      "2026-07-22",
    ]);
  });

  it("returns a single day when start equals end", () => {
    expect(dayKeyRange("2026-07-20", "2026-07-20")).toEqual(["2026-07-20"]);
  });

  it("returns empty for a reversed or unparseable range", () => {
    expect(dayKeyRange("2026-07-22", "2026-07-19")).toEqual([]);
    expect(dayKeyRange("nope", "2026-07-19")).toEqual([]);
  });

  it("spans a DST transition with no duplicate or missing day", () => {
    const days = dayKeyRange("2026-03-06", "2026-03-11");
    expect(days).toEqual([
      "2026-03-06",
      "2026-03-07",
      "2026-03-08",
      "2026-03-09",
      "2026-03-10",
      "2026-03-11",
    ]);
    expect(new Set(days).size).toBe(days.length);
  });
});

describe("parseDayKey", () => {
  it("returns local midnight", () => {
    const parsed = parseDayKey("2026-07-20")!;
    expect(parsed.getFullYear()).toBe(2026);
    expect(parsed.getMonth()).toBe(6);
    expect(parsed.getDate()).toBe(20);
    expect(parsed.getHours()).toBe(0);
  });

  it("returns null for anything that isn't YYYY-MM-DD", () => {
    for (const bad of ["", "2026-7-20", "2026-07-20T00:00:00Z", "garbage"]) {
      expect(parseDayKey(bad)).toBeNull();
    }
  });
});
