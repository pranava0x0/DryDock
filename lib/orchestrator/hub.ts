import type { AgentEvent } from "../providers/types";

/**
 * In-memory pub/sub for live agent events, keyed by runId.
 *
 * Why this exists: the run starts the moment a user clicks "Run" (via POST
 * /api/tasks/[id]/run). The SSE stream that shows the live output is a
 * separate GET request on /stream. Without a broadcast layer, the events
 * would either be consumed by the POST handler (so /stream sees nothing) or
 * we'd have to make POST itself stream — which complicates the UI.
 *
 * The hub keeps a bounded backlog of past events so a client connecting a
 * fraction of a second after POST still gets the full transcript.
 *
 * State lives in the Node process. If Next.js restarts, the subprocess and
 * its event stream are gone anyway, so there's no recovery to do.
 */

interface HubEntry {
  /** Events received so far, in order. */
  history: AgentEvent[];
  /** Subscriber resolvers waiting for the next event. */
  waiters: Array<() => void>;
  /** True once the run has emitted its `exit` event. */
  closed: boolean;
}

const HUB = new Map<string, HubEntry>();

function entry(runId: string): HubEntry {
  let e = HUB.get(runId);
  if (!e) {
    e = { history: [], waiters: [], closed: false };
    HUB.set(runId, e);
  }
  return e;
}

/** Called by the dispatcher for each event the provider yields. */
export function publish(runId: string, event: AgentEvent): void {
  const e = entry(runId);
  e.history.push(event);
  if (event.type === "exit") e.closed = true;
  const waiters = e.waiters;
  e.waiters = [];
  for (const w of waiters) w();
}

/**
 * Subscribe to the live event stream for a run.
 *
 * Yields every event the run has ever produced (history + future events) and
 * terminates once the `exit` event has been delivered. If `signal` aborts —
 * e.g. the SSE client disconnects — the iterator returns cleanly so the
 * caller can release resources.
 */
export async function* subscribe(
  runId: string,
  signal?: AbortSignal,
): AsyncIterable<AgentEvent> {
  // Pin a stable reference to the entry. If `release` later deletes the run
  // from the map, a fresh `entry(runId)` lookup would silently start a brand
  // new conversation — we want to keep observing the original until closure.
  const e = entry(runId);
  let cursor = 0;
  while (true) {
    if (signal?.aborted) return;
    // Drain everything available since the last yield.
    while (cursor < e.history.length) {
      const event = e.history[cursor++];
      yield event;
      if (event.type === "exit") return;
    }
    if (e.closed) return;
    // Wait for the next publish. Tie the wait to the abort signal so a
    // disconnected client doesn't sit here forever.
    await new Promise<void>((resolve) => {
      const onAbort = (): void => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      e.waiters.push(resolve);
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

/**
 * Drop a run from the hub once everyone's done with it. We keep entries
 * around until explicitly cleaned up so late subscribers can still replay
 * the full transcript; for production, prune entries on a TTL or on the
 * `exit` event after a grace period.
 */
export function release(runId: string): void {
  const e = HUB.get(runId);
  if (!e) return;
  // Mark closed BEFORE removing from the map so any subscriber still holding
  // a reference to `e` observes closure on its next loop and terminates.
  e.closed = true;
  const waiters = e.waiters;
  e.waiters = [];
  for (const w of waiters) w();
  HUB.delete(runId);
}

/** Test-only: wipe the hub between cases. */
export function _resetHubForTests(): void {
  HUB.clear();
}
