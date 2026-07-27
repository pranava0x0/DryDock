import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { _resetDbForTests, getDb } from "../db/index";
import { recordQuotaSnapshot } from "../db/quota";
import { quotaStatus, STALE_AFTER_S } from "./quota";
import { parseRateLimits, readCodexQuota } from "./quota-codex";
import { parseStatsCache, readClaudeQuota } from "./quota-claude";

let dir: string;

beforeEach(() => {
  _resetDbForTests();
  dir = mkdtempSync(join(tmpdir(), "drydock-quota-collect-"));
  process.env.DRYDOCK_DB_PATH = join(dir, "test.db");
  getDb();
});

describe("codex app-server rate limits", () => {
  it("maps primary/secondary onto the 5h and weekly windows", () => {
    const result = parseRateLimits({
      rateLimits: {
        primary: {
          usedPercent: 12.5,
          resetsAt: 1_784_000_000,
          windowDurationMins: 300,
        },
        secondary: {
          usedPercent: 58,
          resetsAt: 1_784_500_000,
          windowDurationMins: 10080,
        },
        planType: "plus",
        credits: { balance: 4.25 },
      },
    });

    expect(result.status).toBe("ok");
    expect(result.planType).toBe("plus");
    expect(result.creditsBalance).toBe(4.25);
    const five = result.windows.find((w) => w.window === "5h")!;
    expect(five.usedPct).toBe(12.5);
    expect(five.windowMinutes).toBe(300);
    expect(result.windows.find((w) => w.window === "week")!.usedPct).toBe(58);
  });

  it("accepts the payload unwrapped as well as under rateLimits", () => {
    const result = parseRateLimits({
      primary: { usedPercent: 3, resetsAt: 1_784_000_000 },
    });
    expect(result.status).toBe("ok");
    expect(result.windows).toHaveLength(1);
  });

  it("normalizes a millisecond resetsAt to seconds", () => {
    const result = parseRateLimits({
      primary: { usedPercent: 1, resetsAt: 1_784_000_000_000 },
    });
    expect(result.windows[0].resetsAt).toBe(1_784_000_000);
  });

  it("keeps a missing percentage null instead of defaulting to zero", () => {
    // A 0% would read as "you've barely used your quota" — the exact
    // confident-wrong-value failure this whole spec is guarding.
    const result = parseRateLimits({ primary: { resetsAt: 1_784_000_000 } });
    expect(result.windows[0].usedPct).toBeNull();
  });

  it("reports unavailable for an unrecognized payload", () => {
    expect(parseRateLimits(null).status).toBe("unavailable");
    expect(parseRateLimits({ something: "else" }).status).toBe("unavailable");
    expect(parseRateLimits({}).reason).toMatch(/rate-limit windows/);
  });

  it("says the CLI is not installed rather than leaking ENOENT", async () => {
    // The state on this machine: Codex is driven through the desktop app
    // and VS Code extension, so no `codex` binary is on PATH.
    const result = await readCodexQuota({
      command: "drydock-definitely-not-a-real-binary",
      timeoutMs: 3000,
    });
    expect(result.status).toBe("unavailable");
    expect(result.reason).toContain("not installed");
  });
});

describe("claude stats-cache", () => {
  it("reads percentages and reset times when the cache states them", () => {
    const result = parseStatsCache({
      weekly: { usedPercent: 62, resetsAt: 1_784_000_000 },
      fiveHour: { usedPercent: 8, resetsAt: 1_783_900_000 },
      totals: { totalTokens: 123456, totalCostUsd: 12.5 },
    });
    expect(result.status).toBe("ok");
    expect(result.weeklyUsedPct).toBe(62);
    expect(result.fiveHourUsedPct).toBe(8);
    expect(result.totalTokens).toBe(123456);
  });

  it("normalizes a 0–1 fraction to a percentage", () => {
    // 0.62 rendered as 0.62% would show a nearly-empty bar on a week
    // that's two-thirds gone.
    expect(parseStatsCache({ weekly: { usedPercent: 0.62 } }).weeklyUsedPct)
      .toBeCloseTo(62, 5);
  });

  it("tolerates snake_case and alternate key names", () => {
    const result = parseStatsCache({
      week: { used_percent: 40, resets_at: 1_784_000_000 },
      lifetime: { total_tokens: 99 },
    });
    expect(result.weeklyUsedPct).toBe(40);
    expect(result.totalTokens).toBe(99);
  });

  it("says unavailable — not ok-with-zeros — when the schema is unknown", () => {
    // The schema is undocumented, so this is the likely future. An "ok"
    // full of nulls would look like a working collector reporting no use.
    const result = parseStatsCache({ someFutureShape: { v: 2 } });
    expect(result.status).toBe("unavailable");
    expect(result.reason).toMatch(/schema has changed/);
  });

  it("survives garbage without throwing", () => {
    expect(parseStatsCache(null).status).toBe("unavailable");
    expect(parseStatsCache([1, 2, 3]).status).toBe("unavailable");
    expect(parseStatsCache("nope").status).toBe("unavailable");
  });

  it("reports the missing file plainly (the state on this machine)", async () => {
    const result = await readClaudeQuota(join(dir, "no-stats-cache.json"));
    expect(result.status).toBe("unavailable");
    expect(result.reason).toContain("stats-cache.json");
    expect(result.weeklyUsedPct).toBeNull();
  });

  it("reports invalid JSON distinctly from a missing file", async () => {
    const path = join(dir, "stats-cache.json");
    writeFileSync(path, "{ not json");
    const result = await readClaudeQuota(path);
    expect(result.reason).toContain("not valid JSON");
  });
});

describe("quotaStatus", () => {
  it("attaches age and marks old readings stale", () => {
    const now = 2_000_000;
    recordQuotaSnapshot({
      provider: "codex",
      window: "week",
      used_pct: 58,
      source: "app-server",
      captured_at: now - 60,
    });
    recordQuotaSnapshot({
      provider: "claude",
      window: "week",
      used_pct: 20,
      source: "stats-cache",
      captured_at: now - STALE_AFTER_S - 1,
    });

    const views = quotaStatus(undefined, now);
    const codex = views.find((v) => v.provider === "codex")!;
    const claude = views.find((v) => v.provider === "claude")!;
    expect(codex.ageSeconds).toBe(60);
    expect(codex.stale).toBe(false);
    expect(claude.stale).toBe(true);
  });

  it("returns nothing for a provider with no sanctioned surface", () => {
    // Google has no machine-readable quota anywhere. An empty list is the
    // honest answer; a fabricated percentage to make three cards look
    // symmetrical would not be.
    expect(quotaStatus("google")).toEqual([]);
  });
});
