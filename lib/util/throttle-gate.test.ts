import { describe, expect, it } from "vitest";
import { createThrottleGate } from "./throttle-gate";

/**
 * Time is injected via a closure-controlled `now()` function so tests are
 * deterministic — no setTimeout, no vi.useFakeTimers needed.
 */
function fakeNow(initial = 0) {
  let t = initial;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("createThrottleGate", () => {
  it("opens on the very first call regardless of `now`", () => {
    const clock = fakeNow(0);
    const gate = createThrottleGate(60_000, clock.now);
    expect(gate.check()).toBe(true);
  });

  it("closes for subsequent calls inside the window", () => {
    const clock = fakeNow(0);
    const gate = createThrottleGate(60_000, clock.now);
    expect(gate.check()).toBe(true);
    clock.advance(100);
    expect(gate.check()).toBe(false);
    clock.advance(59_899);
    expect(gate.check()).toBe(false);
  });

  it("reopens exactly at `minIntervalMs` after the last pass", () => {
    const clock = fakeNow(0);
    const gate = createThrottleGate(60_000, clock.now);
    expect(gate.check()).toBe(true);
    clock.advance(60_000);
    expect(gate.check()).toBe(true);
  });

  it("stays closed for many calls in a tight burst (the scroll-event case)", () => {
    const clock = fakeNow(0);
    const gate = createThrottleGate(60_000, clock.now);
    expect(gate.check()).toBe(true);
    let opened = 0;
    for (let i = 0; i < 500; i += 1) {
      clock.advance(20); // 500 events over 10s of scrolling
      if (gate.check()) opened += 1;
    }
    expect(opened).toBe(0);
  });

  it("reopens after the burst once the window clears", () => {
    const clock = fakeNow(0);
    const gate = createThrottleGate(60_000, clock.now);
    expect(gate.check()).toBe(true);
    for (let i = 0; i < 100; i += 1) {
      clock.advance(100);
      gate.check();
    }
    clock.advance(60_000);
    expect(gate.check()).toBe(true);
  });

  it("remaining() reports milliseconds until the next pass", () => {
    const clock = fakeNow(0);
    const gate = createThrottleGate(60_000, clock.now);
    expect(gate.remaining()).toBe(0);
    gate.check();
    expect(gate.remaining()).toBe(60_000);
    clock.advance(25_000);
    expect(gate.remaining()).toBe(35_000);
    clock.advance(35_000);
    expect(gate.remaining()).toBe(0);
  });

  it("reset() lets the next call pass immediately", () => {
    const clock = fakeNow(0);
    const gate = createThrottleGate(60_000, clock.now);
    expect(gate.check()).toBe(true);
    expect(gate.check()).toBe(false);
    gate.reset();
    expect(gate.check()).toBe(true);
  });

  it("multiple independent gates don't share state", () => {
    const clock = fakeNow(0);
    const gateA = createThrottleGate(60_000, clock.now);
    const gateB = createThrottleGate(60_000, clock.now);
    expect(gateA.check()).toBe(true);
    expect(gateB.check()).toBe(true);
    expect(gateA.check()).toBe(false);
    // gateB shouldn't be closed just because gateA is
    expect(gateB.check()).toBe(false);
  });
});
