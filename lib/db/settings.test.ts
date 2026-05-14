import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetDbForTests, getDb } from "./index";
import {
  deleteSetting,
  getBooleanSetting,
  getNumberSetting,
  getSetting,
  setSetting,
} from "./settings";

beforeEach(() => {
  _resetDbForTests();
  const dir = mkdtempSync(join(tmpdir(), "drydock-settings-test-"));
  process.env.DRYDOCK_DB_PATH = join(dir, "test.db");
  getDb();
});

describe("settings store", () => {
  it("round-trips string values via get/set/delete", () => {
    expect(getSetting("apple_notes_title")).toBeNull();
    setSetting("apple_notes_title", "DryDock Backlog");
    expect(getSetting("apple_notes_title")).toBe("DryDock Backlog");
    setSetting("apple_notes_title", "Renamed");
    expect(getSetting("apple_notes_title")).toBe("Renamed");
    deleteSetting("apple_notes_title");
    expect(getSetting("apple_notes_title")).toBeNull();
  });

  it("getNumberSetting returns null for missing or non-numeric values", () => {
    expect(getNumberSetting("monthly_budget_usd")).toBeNull();
    setSetting("monthly_budget_usd", "not a number");
    expect(getNumberSetting("monthly_budget_usd")).toBeNull();
    setSetting("monthly_budget_usd", "42.5");
    expect(getNumberSetting("monthly_budget_usd")).toBeCloseTo(42.5);
  });
});

describe("getBooleanSetting", () => {
  it('treats only the literal "true" as true', () => {
    setSetting("flag", "true");
    expect(getBooleanSetting("flag")).toBe(true);
  });

  it.each([
    ["false", false],
    ["1", false],
    ["yes", false],
    ["TRUE", false],
    ["", false],
  ])(
    'treats %j as false so opt-in behaviors never silently flip on',
    (stored, expected) => {
      setSetting("flag", stored);
      expect(getBooleanSetting("flag")).toBe(expected);
    },
  );

  it("returns the fallback when the key is missing", () => {
    expect(getBooleanSetting("missing")).toBe(false);
    expect(getBooleanSetting("missing", true)).toBe(true);
  });
});
