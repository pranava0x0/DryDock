import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdleBackoff } from "./idle-backoff";

/**
 * Uses vitest's fake timers so the test runs in microseconds rather than
 * waiting on wall-clock. `vi.advanceTimersByTime(n)` fires every pending
 * timer whose scheduled time falls inside `[now, now+n]`, in scheduling
 * order — exactly what we need to simulate "60s passed, did the backoff
 * fire?"
 */

describe("createIdleBackoff", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires exactly at baseMs after resetAndArm", () => {
    let fired = 0;
    const b = createIdleBackoff({
      baseMs: 60_000,
      maxMs: 600_000,
      onFire: () => {
        fired += 1;
      },
    });
    b.resetAndArm();
    vi.advanceTimersByTime(59_999);
    expect(fired).toBe(0);
    vi.advanceTimersByTime(1);
    expect(fired).toBe(1);
    b.teardown();
  });

  it("doubles delay after each fire, capped at maxMs", () => {
    let fired = 0;
    const b = createIdleBackoff({
      baseMs: 1_000,
      maxMs: 4_000,
      onFire: () => {
        fired += 1;
      },
    });
    b.resetAndArm();
    expect(b.currentDelayMs()).toBe(1_000);

    vi.advanceTimersByTime(1_000);
    expect(fired).toBe(1);
    expect(b.currentDelayMs()).toBe(2_000);

    vi.advanceTimersByTime(2_000);
    expect(fired).toBe(2);
    expect(b.currentDelayMs()).toBe(4_000);

    vi.advanceTimersByTime(4_000);
    expect(fired).toBe(3);
    expect(b.currentDelayMs()).toBe(4_000); // capped

    vi.advanceTimersByTime(4_000);
    expect(fired).toBe(4);
    expect(b.currentDelayMs()).toBe(4_000); // still capped

    b.teardown();
  });

  it("resetAndArm cancels the in-flight timer and starts over at baseMs", () => {
    let fired = 0;
    const b = createIdleBackoff({
      baseMs: 1_000,
      maxMs: 8_000,
      onFire: () => {
        fired += 1;
      },
    });
    b.resetAndArm();
    vi.advanceTimersByTime(500); // half-way through first delay
    b.resetAndArm(); // cancel, re-arm with base
    vi.advanceTimersByTime(500); // would have been original fire-time
    expect(fired).toBe(0);
    vi.advanceTimersByTime(500); // 1s after the reset → fires
    expect(fired).toBe(1);
    b.teardown();
  });

  it("resetAndArm after multiple fires goes back to base, then resumes doubling", () => {
    let fired = 0;
    const b = createIdleBackoff({
      baseMs: 1_000,
      maxMs: 8_000,
      onFire: () => {
        fired += 1;
      },
    });
    b.resetAndArm();
    vi.advanceTimersByTime(1_000); // fire 1, delay now 2_000
    vi.advanceTimersByTime(2_000); // fire 2, delay now 4_000
    expect(b.currentDelayMs()).toBe(4_000);

    b.resetAndArm();
    expect(b.currentDelayMs()).toBe(1_000);
    vi.advanceTimersByTime(1_000); // fire 3
    expect(fired).toBe(3);
    expect(b.currentDelayMs()).toBe(2_000);

    b.teardown();
  });

  it("teardown stops the next fire", () => {
    let fired = 0;
    const b = createIdleBackoff({
      baseMs: 1_000,
      maxMs: 8_000,
      onFire: () => {
        fired += 1;
      },
    });
    b.resetAndArm();
    vi.advanceTimersByTime(500);
    b.teardown();
    vi.advanceTimersByTime(10_000);
    expect(fired).toBe(0);
  });

  it("teardown after a fire prevents the auto-rearm chain", () => {
    let fired = 0;
    const b = createIdleBackoff({
      baseMs: 1_000,
      maxMs: 8_000,
      onFire: () => {
        fired += 1;
      },
    });
    b.resetAndArm();
    vi.advanceTimersByTime(1_000);
    expect(fired).toBe(1);
    b.teardown();
    vi.advanceTimersByTime(60_000);
    expect(fired).toBe(1);
  });

  it("resetAndArm is a no-op after teardown", () => {
    let fired = 0;
    const b = createIdleBackoff({
      baseMs: 1_000,
      maxMs: 8_000,
      onFire: () => {
        fired += 1;
      },
    });
    b.teardown();
    b.resetAndArm();
    vi.advanceTimersByTime(60_000);
    expect(fired).toBe(0);
  });

  it("survives onFire calling resetAndArm without double-arming", () => {
    let fired = 0;
    // Hold a reference we can capture in the closure so onFire can call it.
    let b: ReturnType<typeof createIdleBackoff>;
    b = createIdleBackoff({
      baseMs: 1_000,
      maxMs: 8_000,
      onFire: () => {
        fired += 1;
        if (fired === 1) b.resetAndArm(); // mid-fire reset
      },
    });
    b.resetAndArm();
    vi.advanceTimersByTime(1_000); // fires, then onFire calls resetAndArm
    expect(fired).toBe(1);
    // After the reset, delay should be back at base.
    expect(b.currentDelayMs()).toBe(1_000);
    // Only the resetAndArm-armed timer should be live; advancing by 1s
    // should fire exactly once, not twice (the original chain didn't
    // double-arm on top of resetAndArm's new timer).
    vi.advanceTimersByTime(1_000);
    expect(fired).toBe(2);
    // And delay should now have doubled once.
    expect(b.currentDelayMs()).toBe(2_000);
    b.teardown();
  });

  it("survives onFire calling teardown without re-arming", () => {
    let fired = 0;
    let b: ReturnType<typeof createIdleBackoff>;
    b = createIdleBackoff({
      baseMs: 1_000,
      maxMs: 8_000,
      onFire: () => {
        fired += 1;
        b.teardown();
      },
    });
    b.resetAndArm();
    vi.advanceTimersByTime(1_000);
    expect(fired).toBe(1);
    vi.advanceTimersByTime(60_000);
    expect(fired).toBe(1);
  });
});
