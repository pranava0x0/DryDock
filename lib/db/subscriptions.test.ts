import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetDbForTests, getDb } from "./index";
import {
  DEFAULT_CAP_NOTES,
  deleteSubscription,
  getSubscription,
  listSubscriptions,
  upsertSubscription,
} from "./subscriptions";

beforeEach(() => {
  _resetDbForTests();
  const dir = mkdtempSync(join(tmpdir(), "drydock-subs-test-"));
  process.env.DRYDOCK_DB_PATH = join(dir, "test.db");
  getDb();
});

describe("subscription registry", () => {
  it("creates a row and seeds default cap notes", () => {
    const { written, subscription } = upsertSubscription("claude", {
      plan_name: "Max 20x",
      price_usd_month: 200,
      renewal_day: 14,
    });
    expect(written).toBe(true);
    expect(subscription!.plan_name).toBe("Max 20x");
    expect(subscription!.source).toBe("manual");
    expect(subscription!.cap_notes).toBe(DEFAULT_CAP_NOTES.claude);
  });

  it("leaves omitted fields alone on update", () => {
    upsertSubscription("claude", { plan_name: "Max 20x", price_usd_month: 200 });
    upsertSubscription("claude", { renewal_day: 3 });
    const sub = getSubscription("claude")!;
    expect(sub.plan_name).toBe("Max 20x");
    expect(sub.price_usd_month).toBe(200);
    expect(sub.renewal_day).toBe(3);
  });

  it("allows an explicit null to clear a field", () => {
    upsertSubscription("claude", { price_usd_month: 200 });
    upsertSubscription("claude", { price_usd_month: null });
    expect(getSubscription("claude")!.price_usd_month).toBeNull();
  });

  it("refuses to let a collector overwrite manual data", () => {
    // The precedence that matters: a flaky scraper must never silently
    // rewrite the number the user typed.
    upsertSubscription("codex", {
      plan_name: "ChatGPT Plus",
      price_usd_month: 20,
      source: "manual",
    });
    const attempt = upsertSubscription("codex", {
      plan_name: "Team",
      price_usd_month: 30,
      source: "browser",
    });

    expect(attempt.written).toBe(false);
    const sub = getSubscription("codex")!;
    expect(sub.plan_name).toBe("ChatGPT Plus");
    expect(sub.price_usd_month).toBe(20);
    expect(sub.source).toBe("manual");
  });

  it("lets a collector fill a row that does not exist yet", () => {
    const { written, subscription } = upsertSubscription("google", {
      plan_name: "AI Pro",
      source: "receipt",
    });
    expect(written).toBe(true);
    expect(subscription!.source).toBe("receipt");
  });

  it("lets a collector update its own earlier row", () => {
    upsertSubscription("google", { price_usd_month: 19.99, source: "receipt" });
    const again = upsertSubscription("google", {
      price_usd_month: 21.99,
      source: "receipt",
    });
    expect(again.written).toBe(true);
    expect(getSubscription("google")!.price_usd_month).toBe(21.99);
  });

  it("lets the user take a collector-written row back over", () => {
    upsertSubscription("google", { price_usd_month: 19.99, source: "browser" });
    const manual = upsertSubscription("google", {
      price_usd_month: 21.99,
      source: "manual",
    });
    expect(manual.written).toBe(true);
    expect(getSubscription("google")!.source).toBe("manual");
  });

  it("lists rows in provider order and deletes", () => {
    upsertSubscription("google", {});
    upsertSubscription("claude", {});
    expect(listSubscriptions().map((s) => s.provider)).toEqual([
      "claude",
      "google",
    ]);
    expect(deleteSubscription("claude")).toBe(true);
    expect(deleteSubscription("claude")).toBe(false);
    expect(getSubscription("claude")).toBeNull();
  });
});
