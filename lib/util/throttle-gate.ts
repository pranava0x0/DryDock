/**
 * Tiny leading-edge throttle gate.
 *
 * `check()` returns `true` for the first call and again only after
 * `minIntervalMs` has elapsed since the last `true`. Returns `false` in
 * between. State is held in a closure; no globals.
 *
 * Used by the Settings page to keep interaction-triggered budget refreshes
 * to at most once per minute regardless of how many click/scroll events
 * fire. The cost per closed-gate call is one `now()` call + one subtraction
 * — cheap enough to hang off `scroll` without instrumentation.
 *
 * `now` is injectable so tests can advance time without timers.
 */
export interface ThrottleGate {
  /** Returns true and resets the clock; or false if still within the window. */
  check(): boolean;
  /** Returns ms until `check()` will next return true. 0 if the gate is open. */
  remaining(): number;
  /** Force the gate open on next `check()`. */
  reset(): void;
}

export function createThrottleGate(
  minIntervalMs: number,
  now: () => number = () => Date.now(),
): ThrottleGate {
  // -Infinity so the first `check()` always passes regardless of what
  // `now()` returns (even 0, which a test clock might use).
  let lastPassAt = -Infinity;
  return {
    check(): boolean {
      const t = now();
      if (t - lastPassAt < minIntervalMs) return false;
      lastPassAt = t;
      return true;
    },
    remaining(): number {
      const t = now();
      const elapsed = t - lastPassAt;
      return elapsed >= minIntervalMs ? 0 : minIntervalMs - elapsed;
    },
    reset(): void {
      lastPassAt = -Infinity;
    },
  };
}
