/**
 * Zero-dependency token bucket for the highest-consequence write in the
 * app: session kickoff (it spawns a subprocess). This is a throttle for a
 * stolen-credential or runaway-client burst, NOT a substitute for auth —
 * the middleware has already authenticated the caller by the time a route
 * consults the bucket.
 *
 * In-process state (resets on restart) is fine for that purpose, matching
 * the ACTIVE_RUNS reasoning in dispatch.ts. `now` is injectable so tests
 * can advance time without timers (same pattern as util/throttle-gate.ts).
 */

export type TakeResult = { ok: true } | { ok: false; retryAfterSec: number };

export interface TokenBucket {
  /** Consume one token, or report how long until one is available. */
  take(): TakeResult;
}

export function createTokenBucket(
  capacity: number,
  refillPerMinute: number,
  now: () => number = () => Date.now(),
): TokenBucket {
  const refillPerMs = refillPerMinute / 60_000;
  let tokens = capacity;
  let lastRefillAt = now();
  return {
    take(): TakeResult {
      const t = now();
      tokens = Math.min(capacity, tokens + (t - lastRefillAt) * refillPerMs);
      lastRefillAt = t;
      if (tokens >= 1) {
        tokens -= 1;
        return { ok: true };
      }
      const msUntilNextToken = (1 - tokens) / refillPerMs;
      return { ok: false, retryAfterSec: Math.ceil(msUntilNextToken / 1000) };
    },
  };
}

// Kickoff budget: a burst of 10, refilling 10/min. A human tapping "Start
// session" never notices; a script hammering the tunnel gets 429s while at
// most `max_concurrent_runs` agents actually run (the cap is the real
// backstop — this just keeps the queue from silting up).
const KICKOFF_CAPACITY = 10;
const KICKOFF_REFILL_PER_MINUTE = 10;

let kickoffBucket = createTokenBucket(KICKOFF_CAPACITY, KICKOFF_REFILL_PER_MINUTE);

export function takeSessionKickoffToken(): TakeResult {
  return kickoffBucket.take();
}

/** Swap in a fresh bucket (optionally on a test clock) between test cases. */
export function _resetSessionRateLimitForTests(now?: () => number): void {
  kickoffBucket = createTokenBucket(
    KICKOFF_CAPACITY,
    KICKOFF_REFILL_PER_MINUTE,
    now,
  );
}
