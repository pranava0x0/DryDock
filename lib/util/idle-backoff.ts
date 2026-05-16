/**
 * Exponential-backoff idle ticker.
 *
 * Used together with `throttle-gate.ts` to drive the Settings page's
 * Claude budget refresh: the throttle gate caps *fetch rate* at 1/min;
 * this backoff decides *when to try* during stretches of no user
 * interaction. The two compose cleanly — backoff fires `onFire`, which
 * runs through the throttle gate; whether or not a fetch actually
 * happens, the backoff doubles its delay and re-arms.
 *
 * Semantics:
 *   - `resetAndArm()` cancels any pending timer, resets delay to
 *     `baseMs`, and arms a fresh timer. Call on every "user activity"
 *     signal (mount, click, scroll, visibilitychange-to-visible).
 *   - When the timer fires, `onFire` is invoked, then delay doubles
 *     (capped at `maxMs`), and a new timer is armed automatically.
 *   - `teardown()` cancels any pending timer and prevents further
 *     re-arming. Call on unmount.
 *
 * Why a leading-edge throttle plus backoff (rather than one or the
 * other): the throttle gate has no opinion about *when* to fetch — it
 * only rate-limits explicit triggers. Without the backoff, an idle tab
 * never refreshes after the user stops interacting. Without the
 * throttle, a scroll-heavy session would fire fetches on every event.
 * Composed, you get "refresh on activity, never more than 1/min;
 * refresh when idle, but ramp down so a tab left open all afternoon
 * doesn't keep reading disk every minute."
 */

export interface IdleBackoffOptions {
  /** Delay before the first fire, and after every `resetAndArm()`. */
  baseMs: number;
  /** Maximum delay — doubling stops at this value. */
  maxMs: number;
  /** Invoked when the timer fires. Errors are not caught. */
  onFire: () => void;
  /** Injectable for tests; defaults to globalThis.setTimeout. */
  setTimeoutFn?: typeof setTimeout;
  /** Injectable for tests; defaults to globalThis.clearTimeout. */
  clearTimeoutFn?: typeof clearTimeout;
}

export interface IdleBackoff {
  resetAndArm(): void;
  teardown(): void;
  /** Observability — for tests and debugging. */
  currentDelayMs(): number;
}

export function createIdleBackoff(options: IdleBackoffOptions): IdleBackoff {
  const {
    baseMs,
    maxMs,
    onFire,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = options;

  let currentDelay = baseMs;
  let handle: ReturnType<typeof setTimeout> | null = null;
  let torn = false;

  const arm = (): void => {
    handle = setTimeoutFn(() => {
      handle = null;
      onFire();
      // If `onFire` (or anything synchronously downstream of it) called
      // `resetAndArm` or `teardown`, `handle` is now non-null (rearmed)
      // or `torn` is true. Bail in either case so we don't double-arm.
      if (handle !== null || torn) return;
      currentDelay = Math.min(currentDelay * 2, maxMs);
      arm();
    }, currentDelay);
  };

  return {
    resetAndArm(): void {
      if (torn) return;
      if (handle !== null) clearTimeoutFn(handle);
      currentDelay = baseMs;
      arm();
    },
    teardown(): void {
      torn = true;
      if (handle !== null) {
        clearTimeoutFn(handle);
        handle = null;
      }
    },
    currentDelayMs(): number {
      return currentDelay;
    },
  };
}
