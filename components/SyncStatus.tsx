"use client";

import { useEffect, useState } from "react";

export interface SyncStatusProps {
  syncing: boolean;
  /** Unix-seconds; null = never synced. */
  lastSyncedAt: number | null;
  /** Most-recent error message, or null. */
  error: string | null;
}

/**
 * Format a Unix-seconds timestamp as a relative "5s ago" / "2m ago"
 * string. Keeps things one-glance compact for the sync badge.
 */
function formatRelative(tsSec: number, nowMs: number): string {
  const diff = Math.max(0, Math.floor(nowMs / 1000 - tsSec));
  if (diff < 5) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

/**
 * Tiny inline status badge for the auto-sync state. Shown next to the
 * /backlog "Sync Notes" button so the user can tell at a glance how
 * fresh their view is — and whether a recent sync attempt failed
 * without having to dig into devtools.
 *
 * Error takes precedence over syncing/idle so a transient permission
 * issue doesn't get hidden by an in-progress poll.
 */
export function SyncStatus({ syncing, lastSyncedAt, error }: SyncStatusProps) {
  // Re-tick every 10s so "Synced 30s ago" doesn't go stale between
  // polls. Cheap setInterval; component is tiny.
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(id);
  }, []);

  if (error) {
    return (
      <span
        className="inline-flex items-center gap-1 text-xs text-kraken-alert"
        title={error}
        role="status"
      >
        <span aria-hidden="true">⚠</span>
        Sync failed
      </span>
    );
  }
  if (syncing) {
    return (
      <span
        className="inline-flex items-center gap-1 text-xs text-kraken-shadow"
        role="status"
      >
        <span
          aria-hidden="true"
          className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-kraken-ice"
        />
        Syncing…
      </span>
    );
  }
  if (lastSyncedAt) {
    return (
      <span
        className="text-xs text-kraken-shadow"
        title={new Date(lastSyncedAt * 1000).toLocaleString()}
      >
        Synced {formatRelative(lastSyncedAt, now)}
      </span>
    );
  }
  return null;
}
