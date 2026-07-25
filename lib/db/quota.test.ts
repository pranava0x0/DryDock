import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetDbForTests, getDb } from "./index";
import {
  latestQuotaSnapshots,
  quotaAgeSeconds,
  quotaHistory,
  recordQuotaSnapshot,
} from "./quota";

beforeEach(() => {
  _resetDbForTests();
  const dir = mkdtempSync(join(tmpdir(), "drydock-quota-test-"));
  process.env.DRYDOCK_DB_PATH = join(dir, "test.db");
  getDb();
});

describe("quota snapshots", () => {
  it("round-trips a reading with its window and source", () => {
    const snap = recordQuotaSnapshot({
      provider: "codex",
      window: "week",
      used_pct: 58.5,
      resets_at: 1_784_000_000,
      source: "app-server",
      captured_at: 1_783_000_000,
    });
    expect(snap.used_pct).toBe(58.5);
    expect(snap.window).toBe("week");
    expect(snap.source).toBe("app-server");
  });

  it("keeps used_pct nullable so 'unknown' never collapses to 0%", () => {
    // Google exposes no machine-readable percentage. Storing 0 would
    // render as "you've used none of your quota", which is a confident
    // wrong value; null renders as "unknown".
    const snap = recordQuotaSnapshot({
      provider: "google",
      window: "week",
      source: "manual",
    });
    expect(snap.used_pct).toBeNull();
    expect(snap.resets_at).toBeNull();
  });

  it("returns the newest snapshot per (provider, window)", () => {
    recordQuotaSnapshot({
      provider: "codex",
      window: "week",
      used_pct: 10,
      source: "app-server",
      captured_at: 1000,
    });
    recordQuotaSnapshot({
      provider: "codex",
      window: "week",
      used_pct: 40,
      source: "app-server",
      captured_at: 2000,
    });
    recordQuotaSnapshot({
      provider: "codex",
      window: "5h",
      used_pct: 5,
      source: "app-server",
      captured_at: 1500,
    });

    const latest = latestQuotaSnapshots();
    expect(latest).toHaveLength(2);
    expect(latest.find((s) => s.window === "week")!.used_pct).toBe(40);
    expect(latest.find((s) => s.window === "5h")!.used_pct).toBe(5);
  });

  it("breaks a same-second tie by insertion order, not at random", () => {
    // captured_at is unixepoch() seconds, so two writes in the same
    // second tie — the same class of bug as DD-010's follow-up runs.
    recordQuotaSnapshot({
      provider: "claude",
      window: "week",
      used_pct: 11,
      source: "stats-cache",
      captured_at: 5000,
    });
    recordQuotaSnapshot({
      provider: "claude",
      window: "week",
      used_pct: 22,
      source: "stats-cache",
      captured_at: 5000,
    });
    expect(latestQuotaSnapshots("claude")[0].used_pct).toBe(22);
  });

  it("filters by provider", () => {
    recordQuotaSnapshot({ provider: "codex", window: "week", source: "manual" });
    recordQuotaSnapshot({ provider: "claude", window: "week", source: "manual" });
    expect(latestQuotaSnapshots("claude")).toHaveLength(1);
    expect(latestQuotaSnapshots()).toHaveLength(2);
  });

  it("returns history newest-first, bounded by the limit", () => {
    for (let i = 0; i < 5; i += 1) {
      recordQuotaSnapshot({
        provider: "codex",
        window: "week",
        used_pct: i * 10,
        source: "app-server",
        captured_at: 1000 + i,
      });
    }
    const history = quotaHistory("codex", "week", 3);
    expect(history.map((s) => s.used_pct)).toEqual([40, 30, 20]);
  });

  it("reports age so a stale reading can never render as current", () => {
    const snap = recordQuotaSnapshot({
      provider: "codex",
      window: "week",
      used_pct: 58,
      source: "app-server",
      captured_at: 1000,
    });
    expect(quotaAgeSeconds(snap, 1600)).toBe(600);
    // Clock skew must not produce a negative "captured in the future".
    expect(quotaAgeSeconds(snap, 500)).toBe(0);
  });
});
