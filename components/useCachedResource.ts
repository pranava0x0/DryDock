"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Client-side stale-while-revalidate for a GET endpoint.
 *
 * ── The problem this exists to fix ──────────────────────────────────────
 * Every panel in this app was `useState(null)` + `useEffect(fetch)`. Next's
 * App Router unmounts a page's tree on navigation, so clicking Analytics
 * and back tore down the dashboard and rebuilt it from nothing: four API
 * calls re-fired and the screen reverted to "Reading this week's
 * activity… / loading…" every single time. The data was already known and
 * the server even had it cached — the *client* was the thing throwing it
 * away.
 *
 * So: keep the last good payload outside React.
 *
 *  - **Module-level `Map`** survives unmount, so a return trip paints the
 *    previous numbers on the first frame with no request at all.
 *  - **`sessionStorage`** survives a full reload, so a hard refresh or a
 *    PWA cold start opens on real content instead of a spinner.
 *
 * ── Why it still revalidates ────────────────────────────────────────────
 * Showing cached numbers forever would be the same "looks like success"
 * trap in a new place — a confident dashboard quietly describing last
 * Tuesday. So a cached read still fires a background refresh; `stale` is
 * true while that's in flight, and callers render a small "updating" mark
 * rather than blanking the panel. The panel only shows a loading state
 * when there is genuinely nothing to show.
 *
 * The server half of SWR (`refreshing: true` on the payload) is honoured
 * too: the endpoint answers instantly with stale data while it rebuilds,
 * and a one-shot fetch would leave the client parked on the old numbers
 * under a permanent "refreshing" label. `shouldPoll` schedules a bounded
 * follow-up for exactly that case.
 */

interface Entry<T> {
  data: T;
  /** When this client last received the payload. */
  at: number;
}

/** Survives navigation; lost on reload. The fast path. */
const memory = new Map<string, Entry<unknown>>();

/** Survives reload. Namespaced so it can be cleared as a group. */
const STORAGE_PREFIX = "drydock:cache:";

/**
 * How long a cached payload is served without a background refresh. Short,
 * because every endpoint behind this hook is itself cached server-side —
 * the revalidation is usually a ~40ms round-trip to a warm cache.
 */
const DEFAULT_MAX_AGE_MS = 30_000;

/**
 * Cap on what goes to sessionStorage. A few hundred KB of JSON is fine;
 * megabytes would make every navigation pay a synchronous serialize on the
 * main thread, which is exactly the jank this hook exists to remove.
 */
const MAX_PERSISTED_BYTES = 512 * 1024;

function readStorage<T>(key: string): Entry<T> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_PREFIX + key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("data" in parsed) ||
      !("at" in parsed)
    ) {
      return null;
    }
    return parsed as Entry<T>;
  } catch {
    // Private mode, quota, or a payload written by an older build.
    return null;
  }
}

function writeStorage<T>(key: string, entry: Entry<T>): void {
  if (typeof window === "undefined") return;
  try {
    const raw = JSON.stringify(entry);
    if (raw.length > MAX_PERSISTED_BYTES) return;
    window.sessionStorage.setItem(STORAGE_PREFIX + key, raw);
  } catch {
    // Quota exceeded — the in-memory cache still works, so this is a
    // degraded mode, not a failure worth surfacing.
  }
}

/**
 * Drop every cached entry whose URL starts with `prefix`.
 *
 * Needed by any page that *writes*. A mutation invalidates more than the
 * one URL currently on screen: marking a backlog item done changes what
 * `?status=idea` returns AND what `?status=done` returns, and the filter
 * you aren't looking at is exactly the one whose stale copy would be
 * served the moment you switch to it. Prefix-clearing both is cheaper to
 * reason about than tracking which query a write touched, and the next
 * read re-fetches from the server anyway.
 *
 * Clears the persisted copies too — a survivor in `sessionStorage` would
 * come back on the next reload, which is a stale row that outlives the
 * process that deleted it.
 */
export function invalidateCachedResource(prefix: string): void {
  for (const key of [...memory.keys()]) {
    if (key.startsWith(prefix)) memory.delete(key);
  }
  if (typeof window === "undefined") return;
  try {
    for (const key of Object.keys(window.sessionStorage)) {
      if (key.startsWith(STORAGE_PREFIX + prefix)) {
        window.sessionStorage.removeItem(key);
      }
    }
  } catch {
    // Private mode / quota — the in-memory clear above still happened.
  }
}

export interface CachedResource<T> {
  data: T | null;
  error: string | null;
  /** True only when there is nothing at all to render. */
  loading: boolean;
  /** True when showing cached data while a refresh is in flight. */
  stale: boolean;
  /** When the displayed payload reached this client. Null if never. */
  cachedAt: number | null;
  /** Force a refresh — for an explicit "refresh now" control. */
  refresh: () => void;
}

export interface CachedResourceOptions<T> {
  /** Serve without refreshing for this long. Defaults to 30s. */
  maxAgeMs?: number;
  /**
   * Called with each payload; return true to schedule a bounded follow-up
   * fetch. Use for endpoints that answer stale with `refreshing: true`.
   */
  shouldPoll?: (data: T) => boolean;
  pollIntervalMs?: number;
  maxPolls?: number;
  /** Skip sessionStorage — for payloads too large or too sensitive. */
  persist?: boolean;
  /** Abort a request that hasn't answered in this long. */
  timeoutMs?: number;
}

/**
 * A request that never settles is worse than one that fails: the panel
 * sits on its skeleton forever, which reads as a frozen app rather than a
 * broken request. Observed for real when a dev-server rebuild orphaned an
 * in-flight fetch — and over a phone on a Cloudflare Tunnel it is an
 * ordinary Tuesday. Bound it, so the failure is legible and retryable.
 */
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * What the displayed entry should become when the effect runs.
 *
 * Extracted because this decision is where the bug was (Codex, PR #41) and
 * because it is the only part of the hook testable without a DOM: the
 * suite runs in `node`, so the React behaviour around it is verified in
 * the browser instead.
 *
 * `undefined` means "leave the current entry alone" — distinct from
 * `{next: null}`, which means "blank it", and the difference is the whole
 * point. On a URL change with no cache hit the view MUST blank: continuing
 * to show the previous URL's payload under the new selector is a wrong
 * answer, where blanking is merely a delay.
 */
export function resolveDisplayedEntry<T>(args: {
  urlChanged: boolean;
  cached: Entry<T> | undefined;
  current: Entry<T> | null;
}): { next: Entry<T> | null } | undefined {
  const { urlChanged, cached, current } = args;
  // A different URL always re-points the view, including to nothing.
  if (urlChanged) return { next: cached ?? null };
  // Same URL: only fill a hole. Never overwrite a live entry with a cached
  // one, or a just-arrived payload would be replaced by an older copy.
  if (cached !== undefined && current === null) return { next: cached };
  return undefined;
}

export function useCachedResource<T>(
  url: string,
  options: CachedResourceOptions<T> = {},
): CachedResource<T> {
  const {
    maxAgeMs = DEFAULT_MAX_AGE_MS,
    shouldPoll,
    pollIntervalMs = 3000,
    maxPolls = 10,
    persist = true,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  /**
   * Seeded from the in-memory cache only — deliberately NOT from
   * `sessionStorage`.
   *
   * This render is the one React hydrates against, so whatever it returns
   * has to match what the server rendered. `memory` is safe: it is
   * populated only by a fetch this browser already made, so on a fresh
   * document it is empty, exactly like the server's view. On a
   * client-side navigation there is no hydration at all, and the entry is
   * there — which is the case this hook exists for, and it still paints
   * on the first frame.
   *
   * `sessionStorage` is the opposite: it survives reloads, so it can hold
   * a payload from a *previous* document that the server knew nothing
   * about. Reading it here rendered a populated project dropdown on
   * /backlog against a server-rendered empty one — "Hydration failed",
   * and React then discards the server tree and re-renders the whole
   * page. It is restored one tick later in the effect below, which costs
   * a frame and no network.
   */
  const [entry, setEntry] = useState<Entry<T> | null>(
    () => (memory.get(url) as Entry<T> | undefined) ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const [inFlight, setInFlight] = useState(false);

  // Read in the fetch loop without making it a dependency, so changing
  // these can't restart an in-flight chain.
  const optionsRef = useRef({
    shouldPoll,
    pollIntervalMs,
    maxPolls,
    persist,
    timeoutMs,
  });
  optionsRef.current = { shouldPoll, pollIntervalMs, maxPolls, persist, timeoutMs };

  /**
   * Monotonic generation counter, incremented on every cleanup.
   *
   * This replaced a plain `cancelled` boolean, which was subtly wrong: the
   * ref is shared across URLs, and a re-run of the effect set it back to
   * `false` — *un-cancelling* the request the cleanup had just cancelled.
   * Switching Flow's window from 90d to 30d left the older, slower 90d
   * response free to resolve last and write itself into the 30d view.
   * Wrong numbers under a correct-looking selector, which is the failure
   * mode this codebase is least willing to ship.
   *
   * Each `load` captures the generation it started in and compares after
   * every await, so a superseded request can never win a race against the
   * one that replaced it.
   */
  /**
   * Which URL the currently displayed entry belongs to. The effect compares
   * against this to decide whether it is looking at a genuine URL change
   * (re-point the view) or a re-run for the same URL (leave it alone).
   */
  const displayedUrl = useRef(url);

  /**
   * Mirrors `entry` for the effect to read without taking it as a
   * dependency — depending on the value it also sets would re-run the
   * effect on every payload.
   */
  const entryRef = useRef<Entry<T> | null>(null);

  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const load = useCallback(
    async (polls: number): Promise<void> => {
      const gen = generation.current;
      const current = () => generation.current === gen;
      setInFlight(true);
      const controller = new AbortController();
      const abortTimer = setTimeout(
        () => controller.abort(),
        optionsRef.current.timeoutMs,
      );
      try {
        const res = await fetch(url, { signal: controller.signal });
        const body: unknown = await res.json();
        if (!res.ok) {
          const message =
            typeof body === "object" && body !== null && "error" in body
              ? String((body as { error: unknown }).error)
              : `Request failed (${res.status})`;
          throw new Error(message);
        }

        // Populate the shared cache BEFORE the generation check.
        //
        // Being superseded is a statement about this component's needs —
        // a reason to skip the setState calls below, since there may be
        // nothing to render into. It is NOT a reason to discard a payload
        // that arrived intact: the cache is module scope, keyed by URL,
        // and shared with whatever mounts next.
        //
        // Caching after the guard made the cache useless for exactly the
        // requests that needed it most. The slower the endpoint, the more
        // likely you navigate away mid-flight — so `/api/flow`, a 16–25s
        // git sweep, never once populated the cache while `/api/analytics`
        // always did. Every tab switch back re-paid the whole read.
        const next: Entry<T> = { data: body as T, at: Date.now() };
        memory.set(url, next);
        if (optionsRef.current.persist) writeStorage(url, next);

        if (!current()) return;
        setEntry(next);
        setError(null);

        const { shouldPoll: poll, pollIntervalMs: interval, maxPolls: max } =
          optionsRef.current;
        if (poll?.(next.data) === true && polls < max) {
          timer.current = setTimeout(() => void load(polls + 1), interval);
        }
      } catch (err) {
        // A failed refresh must not discard good cached data — the panel
        // keeps rendering what it has and the error rides alongside.
        if (current()) {
          const aborted = (err as Error).name === "AbortError";
          setError(
            aborted
              ? `Timed out after ${Math.round(optionsRef.current.timeoutMs / 1000)}s`
              : (err as Error).message,
          );
        }
      } finally {
        clearTimeout(abortTimer);
        // Also generation-guarded: a superseded request finishing must not
        // clear the in-flight flag out from under the request that
        // replaced it, or the UI would stop saying "refreshing" while a
        // refresh is still running.
        if (current()) setInFlight(false);
      }
    },
    [url],
  );

  useEffect(() => {
    let cached = memory.get(url) as Entry<T> | undefined;
    // Runs after hydration, so promoting the persisted copy here is safe
    // where doing it during render was not. This is what makes a full
    // reload (or a PWA cold start) open on real content without a
    // request.
    if (cached === undefined && persist) {
      const stored = readStorage<T>(url);
      if (stored) {
        memory.set(url, stored);
        cached = stored;
      }
    }

    // Re-point the displayed entry whenever the URL changes (Codex, PR #41).
    //
    // Without this the hook rendered whatever the *previous* URL had
    // resolved to. The bad case is silent and permanent rather than
    // transient: if the new URL already has a fresh in-memory entry, the
    // fetch below is skipped too, so nothing ever corrects the view — pick
    // 30d in Flow after visiting 90d and you keep reading 90d's numbers
    // under a 30d selector, indefinitely.
    //
    // On a miss this deliberately sets `null`, which surfaces the loading
    // state. Showing another window's figures is strictly worse than
    // showing none: one is a delay, the other is a wrong answer.
    const urlChanged = displayedUrl.current !== url;
    const resolved = resolveDisplayedEntry<T>({
      urlChanged,
      cached,
      current: entryRef.current,
    });
    if (urlChanged) {
      displayedUrl.current = url;
      setError(null);
    }
    if (resolved) setEntry(resolved.next);

    const fresh = cached !== undefined && Date.now() - cached.at < maxAgeMs;
    // A cache hit inside maxAgeMs skips the network entirely. This is the
    // whole point: navigating back within half a minute costs zero
    // requests and paints instantly.
    if (!fresh) void load(0);
    return () => {
      // Bumping the generation is what retires every request started in
      // this pass. It is never reset, so an in-flight response can only
      // ever find itself stale — never un-cancelled by a later mount.
      generation.current += 1;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [url, maxAgeMs, load, persist]);

  const refresh = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    void load(0);
  }, [load]);

  // Kept in step with what is actually rendered, so the effect can consult
  // it without depending on it.
  entryRef.current = entry;

  return {
    data: entry?.data ?? null,
    error,
    loading: entry === null && inFlight,
    stale: entry !== null && inFlight,
    cachedAt: entry?.at ?? null,
    refresh,
  };
}
