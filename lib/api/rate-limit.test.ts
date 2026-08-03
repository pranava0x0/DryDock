import { describe, it, expect } from "vitest";
import { createTokenBucket } from "./rate-limit";

describe("createTokenBucket", () => {
  it("allows a burst up to capacity, then refuses", () => {
    let t = 0;
    const bucket = createTokenBucket(3, 60, () => t);
    expect(bucket.take().ok).toBe(true);
    expect(bucket.take().ok).toBe(true);
    expect(bucket.take().ok).toBe(true);
    const refused = bucket.take();
    expect(refused.ok).toBe(false);
  });

  it("refills continuously as time passes", () => {
    let t = 0;
    // 60/min = 1 token per second.
    const bucket = createTokenBucket(1, 60, () => t);
    expect(bucket.take().ok).toBe(true);
    expect(bucket.take().ok).toBe(false);
    t += 1000;
    expect(bucket.take().ok).toBe(true);
  });

  it("never refills past capacity", () => {
    let t = 0;
    const bucket = createTokenBucket(2, 60, () => t);
    expect(bucket.take().ok).toBe(true);
    expect(bucket.take().ok).toBe(true);
    // A long idle stretch refills to the cap, not beyond it.
    t += 60 * 60 * 1000;
    expect(bucket.take().ok).toBe(true);
    expect(bucket.take().ok).toBe(true);
    expect(bucket.take().ok).toBe(false);
  });

  it("reports whole seconds until the next token", () => {
    let t = 0;
    // 6/min = 1 token per 10 seconds.
    const bucket = createTokenBucket(1, 6, () => t);
    expect(bucket.take().ok).toBe(true);
    const refused = bucket.take();
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.retryAfterSec).toBe(10);
    }
    // Partway through the wait, the estimate shrinks.
    t += 4000;
    const later = bucket.take();
    expect(later.ok).toBe(false);
    if (!later.ok) {
      expect(later.retryAfterSec).toBe(6);
    }
  });
});
