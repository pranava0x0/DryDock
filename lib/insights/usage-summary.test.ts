import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetDbForTests, getDb } from "../db/index";
import { emptyUsageRow, upsertUsageDaily, type UsageDailyRow } from "../db/usage";
import { upsertSubscription } from "../db/subscriptions";
import { localDayKey } from "../util/day";
import { buildUsageSummary } from "./usage-summary";

const NOW = new Date(2026, 6, 25, 12, 0);
const TODAY = localDayKey(NOW);

beforeEach(() => {
  _resetDbForTests();
  const dir = mkdtempSync(join(tmpdir(), "drydock-summary-test-"));
  process.env.DRYDOCK_DB_PATH = join(dir, "test.db");
  getDb();
});

function row(overrides: Partial<UsageDailyRow>): UsageDailyRow {
  return {
    ...emptyUsageRow(TODAY, "claude", "cli", "claude-sonnet", "DryDock"),
    ...overrides,
  };
}

describe("buildUsageSummary — fleet totals", () => {
  it("adds tokens across token-reporting providers only", async () => {
    upsertUsageDaily([
      row({ provider: "claude", total_tokens: 1000, turns: 10, sessions: 2 }),
      row({
        provider: "codex",
        model: "gpt-5.6-sol",
        total_tokens: 500,
        turns: 5,
        sessions: 1,
      }),
      // Google: activity only, zero tokens by construction.
      row({ provider: "google", model: "", project_key: "", events: 40, turns: 7, sessions: 3 }),
    ]);

    const { fleet } = await buildUsageSummary({ now: NOW, windowDays: 7 });
    expect(fleet.totalTokens).toBe(1500);
    expect(fleet.tokenProviders).toEqual(["claude", "codex"]);
    expect(fleet.activityOnlyProviders).toEqual(["google"]);
    // Turns and sessions DO span all three — every provider records them.
    expect(fleet.turns).toBe(22);
    expect(fleet.sessions).toBe(6);
    expect(fleet.events).toBe(40);
  });

  it("counts active days as a union, not a sum", async () => {
    // Two providers used on the same day is one day of work. Summing the
    // per-provider counts would report 60 active days in a 30-day window.
    upsertUsageDaily([
      row({ provider: "claude", total_tokens: 10 }),
      row({ provider: "codex", model: "gpt-5.6-sol", total_tokens: 10 }),
    ]);
    const { fleet } = await buildUsageSummary({ now: NOW, windowDays: 7 });
    expect(fleet.activeDays).toBe(1);
  });

  it("splits by provider share of the token total", async () => {
    upsertUsageDaily([
      row({ provider: "claude", total_tokens: 750 }),
      row({ provider: "codex", model: "gpt-5.6-sol", total_tokens: 250 }),
    ]);
    const { fleet } = await buildUsageSummary({ now: NOW, windowDays: 7 });
    const claude = fleet.split.find((s) => s.provider === "claude")!;
    expect(claude.share).toBeCloseTo(0.75, 5);
    // Google never appears in a token split — it has no tokens to share.
    expect(fleet.split.map((s) => s.provider)).not.toContain("google");
  });

  it("is all zeros, not a crash, on an empty ledger", async () => {
    const { fleet } = await buildUsageSummary({ now: NOW, windowDays: 7 });
    expect(fleet.totalTokens).toBe(0);
    expect(fleet.activeDays).toBe(0);
    expect(fleet.value.coverage).toBe(1);
  });
});

describe("buildUsageSummary — per provider", () => {
  it("marks Google as activity-only so callers can't render its zeros as tokens", async () => {
    const summary = await buildUsageSummary({ now: NOW, windowDays: 7 });
    const google = summary.providers.find((p) => p.provider === "google")!;
    expect(google.tokensAreReal).toBe(false);
    expect(google.value).toBeNull();
  });

  it("emits a dense daily series so quiet days are zeros, not gaps", async () => {
    upsertUsageDaily([row({ total_tokens: 100 })]);
    const summary = await buildUsageSummary({ now: NOW, windowDays: 7 });
    const claude = summary.providers.find((p) => p.provider === "claude")!;
    expect(claude.daily).toHaveLength(7);
    expect(claude.daily[claude.daily.length - 1].day).toBe(TODAY);
    expect(claude.daily[0].totalTokens).toBe(0);
  });

  it("computes model shares over the metric that is real for the provider", async () => {
    // Google's shares must be computed over events, not tokens —
    // otherwise every segment sits at 0% and the bar reads as broken.
    upsertUsageDaily([
      row({ provider: "google", model: "", project_key: "", events: 30 }),
    ]);
    const summary = await buildUsageSummary({ now: NOW, windowDays: 7 });
    const google = summary.providers.find((p) => p.provider === "google")!;
    expect(google.modelMix[0].share).toBe(1);
  });

  it("falls back to seeded cap prose before a subscription exists", async () => {
    const summary = await buildUsageSummary({ now: NOW, windowDays: 7 });
    const claude = summary.providers.find((p) => p.provider === "claude")!;
    expect(claude.subscription).toBeNull();
    expect(claude.capNotes).toMatch(/5-hour/);
  });

  it("surfaces the subscription once entered", async () => {
    upsertSubscription("claude", { plan_name: "Max 20x", price_usd_month: 200 });
    const summary = await buildUsageSummary({ now: NOW, windowDays: 7 });
    const claude = summary.providers.find((p) => p.provider === "claude")!;
    expect(claude.subscription!.plan_name).toBe("Max 20x");
  });

  it("clamps an absurd window rather than building a 100-year array", async () => {
    const summary = await buildUsageSummary({ now: NOW, windowDays: 99_999 });
    expect(summary.windowDays).toBe(730);
    expect(summary.providers[0].daily).toHaveLength(730);
  });
});
