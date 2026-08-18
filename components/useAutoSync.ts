"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface AutoSyncState {
  /** True while a POST /api/backlog/sync is in flight. */
  syncing: boolean;
  /**
   * Unix-seconds of the last successful sync. Loaded from the server
   * on mount (so the badge can read "Synced 5m ago" before the
   * mount-time sync completes), then bumped after each successful
   * sync that this hook triggers.
   */
  lastSyncedAt: number | null;
  /** Error from the most recent sync attempt, or null. */
  error: string | null;
  /** Manual trigger — wire up to a "Sync Notes" button. */
  triggerSync: () => Promise<void>;
}

interface UseAutoSyncOptions {
  /**
   * Poll interval in milliseconds. Omit for one-shot mount-time sync
   * only (the dashboard's "launch" path). Set to e.g. 30_000 on
   * /backlog so an item the user types into Apple Notes shows up
   * within ~30 seconds without them having to click anything.
   */
  intervalMs?: number;
  /** Set to false to disable the auto-trigger (manual only). */
  enabled?: boolean;
  /**
   * Minimum gap between two *mount-time* syncs, across mounts. Defaults
   * to 60s. See `lastMountSyncAt`.
   */
  mountCooldownMs?: number;
}

/**
 * When the mount-time sync last ran, module-scoped so it survives
 * unmount.
 *
 * A mount sync is an `osascript` round-trip into Apple Notes. Client-side
 * navigation unmounts and remounts the dashboard, so without this every
 * trip back from Analytics fired another one — four `/api/backlog/sync`
 * calls per visit once React's dev double-mount is counted. The server
 * mutex made them harmless but not free.
 *
 * Deliberately not in `sessionStorage`: a genuine page load *should*
 * re-sync, because that is the "I just opened the app" moment the sync
 * exists to serve. This only suppresses the remounts within one page
 * lifetime.
 */
let lastMountSyncAt = 0;

const DEFAULT_MOUNT_COOLDOWN_MS = 60_000;

/**
 * Client-side auto-sync orchestrator. Fires one sync on mount, then
 * (optionally) every `intervalMs` while the tab is visible. Pauses
 * polling when the tab is hidden to avoid hammering osascript when
 * the user is doing other things.
 *
 * Errors don't tear down the polling — a sync failure shows an
 * inline message; the next interval still fires. The server-side
 * mutex in syncWithAppleNotes collapses overlapping calls so a
 * user-triggered "Sync Notes" click and a poll firing in the same
 * second don't race.
 */
export function useAutoSync(opts: UseAutoSyncOptions = {}): AutoSyncState {
  const [syncing, setSyncing] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Track tab visibility via a ref so the polling interval can skip
  // firing when hidden without re-creating the interval on every
  // visibility change.
  const visibleRef = useRef(true);

  const trigger = useCallback(async (): Promise<void> => {
    setSyncing(true);
    try {
      const res = await fetch("/api/backlog/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const body = (await res.json()) as {
        lastSyncedAt?: number;
        error?: string;
        mirror?: { status?: string; reason?: string | null };
      };
      if (!res.ok) throw new Error(body.error ?? "Sync failed");
      setLastSyncedAt(body.lastSyncedAt ?? Math.floor(Date.now() / 1000));
      // The GitHub mirror runs in the same tick. Its failure is NOT the
      // Notes sync's failure — Notes may have gone through perfectly —
      // but showing a clean "Synced just now" while every GitHub write
      // in that tick failed is the confident-wrong-value the rest of
      // this codebase works hard to avoid. `disabled` is silent: no
      // tracker repo configured is a setting, not a problem.
      const mirror = body.mirror;
      setError(
        mirror && mirror.status === "unavailable"
          ? `GitHub mirror: ${mirror.reason ?? "unavailable"}`
          : null,
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSyncing(false);
    }
  }, []);

  const mountCooldownMs = opts.mountCooldownMs ?? DEFAULT_MOUNT_COOLDOWN_MS;

  useEffect(() => {
    if (opts.enabled === false) return;
    let cancelled = false;

    // GET first to populate "Synced X ago" before our sync completes.
    // Avoids the brief flash of "Never synced" on every page mount.
    void fetch("/api/backlog/sync")
      .then((r) => r.json())
      .then((data: { lastSyncedAt?: number | null }) => {
        if (!cancelled && data.lastSyncedAt != null) {
          setLastSyncedAt(data.lastSyncedAt);
        }
      })
      .catch(() => {
        // Ignore — the trigger below will surface any real error.
      });

    // Skip the mount sync if one ran recently in this page lifetime. The
    // interval path below and the manual `triggerSync` both bypass this —
    // a cooldown on "the user asked" or "the poll is due" would be a bug,
    // not an optimisation.
    if (Date.now() - lastMountSyncAt >= mountCooldownMs) {
      lastMountSyncAt = Date.now();
      void trigger();
    }

    if (!opts.intervalMs) {
      return () => {
        cancelled = true;
      };
    }

    const onVisibility = (): void => {
      visibleRef.current = !document.hidden;
      // When the tab regains focus, fire an immediate sync so the
      // user doesn't have to wait up to intervalMs to see what
      // changed in Notes while they were elsewhere.
      if (!document.hidden) void trigger();
    };
    document.addEventListener("visibilitychange", onVisibility);

    const id = window.setInterval(() => {
      if (visibleRef.current) void trigger();
    }, opts.intervalMs);

    return () => {
      cancelled = true;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [trigger, opts.intervalMs, opts.enabled, mountCooldownMs]);

  return { syncing, lastSyncedAt, error, triggerSync: trigger };
}
