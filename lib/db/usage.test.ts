import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetDbForTests, getDb } from "./index";
import {
  distinctSessionDays,
  emptyUsageRow,
  latestUsageDay,
  listUsageDaily,
  replaceUsageDailyRange,
  upsertUsageDaily,
  usageBy,
  usageTotals,
  type UsageDailyRow,
} from "./usage";

beforeEach(() => {
  _resetDbForTests();
  const dir = mkdtempSync(join(tmpdir(), "drydock-usage-test-"));
  process.env.DRYDOCK_DB_PATH = join(dir, "test.db");
  getDb();
});

function row(
  day: string,
  overrides: Partial<UsageDailyRow> = {},
): UsageDailyRow {
  return {
    ...emptyUsageRow(day, "claude", "cli", "claude-sonnet", "DryDock"),
    input_tokens: 10,
    output_tokens: 5,
    total_tokens: 15,
    turns: 1,
    sessions: 1,
    ...overrides,
  };
}

describe("usage ledger", () => {
  it("upserts idempotently — collecting the same day twice is a no-op", () => {
    // The whole partial-day self-healing story rests on this: a collect
    // that runs mid-day and again an hour later must not double the
    // morning's tokens.
    upsertUsageDaily([row("2026-07-20")]);
    upsertUsageDaily([row("2026-07-20")]);

    const rows = listUsageDaily();
    expect(rows).toHaveLength(1);
    expect(rows[0].input_tokens).toBe(10);
    expect(usageTotals().total_tokens).toBe(15);
  });

  it("upsert overwrites rather than accumulates on re-collect", () => {
    upsertUsageDaily([row("2026-07-20", { input_tokens: 10 })]);
    upsertUsageDaily([row("2026-07-20", { input_tokens: 40 })]);
    expect(listUsageDaily()[0].input_tokens).toBe(40);
  });

  it("keeps dimensions separate — same day, two models", () => {
    upsertUsageDaily([
      row("2026-07-20", { model: "claude-sonnet", input_tokens: 10 }),
      row("2026-07-20", { model: "claude-haiku", input_tokens: 3 }),
    ]);
    expect(listUsageDaily()).toHaveLength(2);
    const byModel = usageBy("model");
    expect(byModel.map((s) => s.key).sort()).toEqual([
      "claude-haiku",
      "claude-sonnet",
    ]);
  });

  it("replaceUsageDailyRange clears stale rows the recollect no longer produces", () => {
    // The reason collectors don't use a plain upsert: if the user stops
    // using a model, a pure upsert leaves its row behind forever and
    // every total keeps counting it.
    upsertUsageDaily([
      row("2026-07-20", { model: "claude-haiku", input_tokens: 3 }),
      row("2026-07-20", { model: "claude-sonnet", input_tokens: 10 }),
    ]);
    replaceUsageDailyRange("claude", "cli", "2026-07-20", [
      row("2026-07-20", { model: "claude-sonnet", input_tokens: 12 }),
    ]);

    const rows = listUsageDaily();
    expect(rows).toHaveLength(1);
    expect(rows[0].model).toBe("claude-sonnet");
    expect(rows[0].input_tokens).toBe(12);
  });

  it("replaceUsageDailyRange leaves days before the cursor untouched", () => {
    upsertUsageDaily([
      row("2026-07-18", { input_tokens: 100 }),
      row("2026-07-19", { input_tokens: 200 }),
    ]);
    replaceUsageDailyRange("claude", "cli", "2026-07-19", [
      row("2026-07-19", { input_tokens: 5 }),
    ]);

    const rows = listUsageDaily();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.day === "2026-07-18")!.input_tokens).toBe(100);
    expect(rows.find((r) => r.day === "2026-07-19")!.input_tokens).toBe(5);
  });

  it("replaceUsageDailyRange only touches its own provider and surface", () => {
    // A Claude recollect must never clear the Codex ledger, and a web
    // import must never clear the CLI rows.
    upsertUsageDaily([
      row("2026-07-20", { provider: "codex", model: "gpt-5.6-sol" }),
      row("2026-07-20", { surface: "web" }),
      row("2026-07-20"),
    ]);
    replaceUsageDailyRange("claude", "cli", "2026-07-20", []);

    const rows = listUsageDaily();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => `${r.provider}/${r.surface}`).sort()).toEqual([
      "claude/web",
      "codex/cli",
    ]);
  });

  it("an empty replace with no rows still clears the range", () => {
    upsertUsageDaily([row("2026-07-20")]);
    replaceUsageDailyRange("claude", "cli", "2026-07-20", []);
    expect(listUsageDaily()).toHaveLength(0);
  });

  it("filters by provider and day range", () => {
    upsertUsageDaily([
      row("2026-07-18"),
      row("2026-07-20"),
      row("2026-07-22", { provider: "codex" }),
    ]);
    expect(listUsageDaily({ provider: "claude" })).toHaveLength(2);
    expect(
      listUsageDaily({ fromDay: "2026-07-19", toDay: "2026-07-21" }),
    ).toHaveLength(1);
  });

  it("totals sum every numeric column and count distinct days", () => {
    upsertUsageDaily([
      row("2026-07-20", { input_tokens: 10, output_tokens: 5, total_tokens: 15, turns: 2 }),
      row("2026-07-21", { input_tokens: 1, output_tokens: 1, total_tokens: 2, turns: 3 }),
    ]);
    const totals = usageTotals();
    expect(totals.input_tokens).toBe(11);
    expect(totals.total_tokens).toBe(17);
    expect(totals.turns).toBe(5);
    expect(totals.days).toBe(2);
  });

  it("groups by project, keeping '' for unknown rather than inventing a name", () => {
    upsertUsageDaily([
      row("2026-07-20", { project_key: "DryDock", total_tokens: 30 }),
      row("2026-07-20", { project_key: "", total_tokens: 10 }),
    ]);
    const slices = usageBy("project_key");
    expect(slices[0].key).toBe("DryDock");
    expect(slices[1].key).toBe("");
  });

  it("reports the newest day, per provider and overall", () => {
    expect(latestUsageDay()).toBeNull();
    upsertUsageDaily([
      row("2026-07-20"),
      row("2026-07-24", { provider: "codex" }),
    ]);
    expect(latestUsageDay()).toBe("2026-07-24");
    expect(latestUsageDay("claude")).toBe("2026-07-20");
  });

  it("rejects an unknown group-by dimension instead of interpolating it", () => {
    // The one place SQL is built from a non-parameter. Keep it closed.
    expect(() =>
      usageBy("day; DROP TABLE usage_daily" as never),
    ).toThrow(/unsupported dimension/);
  });
});

describe("session counting (Codex P2, PR #8)", () => {
  it("does NOT double-count a session that used two models on one day", () => {
    // The ledger's grain puts `sessions` on every row, so one session
    // spanning two models is stored as 1 twice. Summing reported 2, and
    // the Usage tab rendered that as "SESSIONS".
    upsertUsageDaily([
      row("2026-07-20", { model: "claude-opus-4-8", sessions: 1 }),
      row("2026-07-20", { model: "claude-sonnet-5", sessions: 1 }),
    ]);
    expect(usageTotals().sessions).toBe(2); // the raw sum, still available
    expect(distinctSessionDays()).toBe(1); // what a human should be shown
  });

  it("adds up across days and providers", () => {
    upsertUsageDaily([
      row("2026-07-20", { sessions: 2 }),
      row("2026-07-21", { sessions: 3 }),
      row("2026-07-21", { provider: "codex", model: "gpt-5.6-sol", sessions: 1 }),
    ]);
    // 2 (Mon claude) + 3 (Tue claude) + 1 (Tue codex).
    expect(distinctSessionDays()).toBe(6);
  });

  it("respects the query filters", () => {
    upsertUsageDaily([
      row("2026-07-20", { sessions: 2 }),
      row("2026-07-25", { sessions: 5 }),
    ]);
    expect(distinctSessionDays({ toDay: "2026-07-21" })).toBe(2);
    expect(distinctSessionDays({ provider: "codex" })).toBe(0);
  });

  it("is zero, not a crash, on an empty ledger", () => {
    expect(distinctSessionDays()).toBe(0);
  });
});

describe("cache writes are priced separately (Codex P2, PR #8)", () => {
  it("keeps reads and writes in distinct columns", () => {
    // A cache READ costs ~10% of input; a cache WRITE costs ~25% MORE.
    // Merging them and pricing at the read rate understated every long
    // session's API-equivalent value.
    upsertUsageDaily([
      row("2026-07-20", { cached_tokens: 1000, cache_write_tokens: 500 }),
    ]);
    const [stored] = listUsageDaily();
    expect(stored.cached_tokens).toBe(1000);
    expect(stored.cache_write_tokens).toBe(500);
    expect(usageTotals().cache_write_tokens).toBe(500);
  });
});
