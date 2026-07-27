import { getNumberSetting, getSetting, setSetting } from "../db/settings";
import type { ConnectorKey } from "./types";

/**
 * Connector watermarks, stored in `settings` under one keyspace per
 * connector — the same shape as `apple_notes_last_sync_at`.
 *
 *   connector.<key>.last_sync_at   unix seconds of the last good collect
 *   connector.<key>.cursor         connector-defined resume point
 *
 * For the usage collectors the cursor is a `YYYY-MM-DD` day key meaning
 * "recompute from this day forward next time". It is deliberately set to
 * *yesterday* rather than today: a turn at 23:59:58 can be flushed to
 * disk after midnight, so a cursor of "today" would freeze yesterday's
 * total a couple of seconds early and quietly lose the tail of a late
 * night. Recomputing two days costs nothing — the mtime pre-filter skips
 * every file that can't contribute.
 *
 * Like the Apple Notes timestamp, `last_sync_at` is only stamped after a
 * collect completes without throwing. A half-finished run leaves the old
 * value so the UI keeps showing an honest older freshness rather than
 * claiming a round that didn't finish.
 */

export function lastSyncKey(key: ConnectorKey): string {
  return `connector.${key}.last_sync_at`;
}

export function cursorKey(key: ConnectorKey): string {
  return `connector.${key}.cursor`;
}

export function getLastSyncAt(key: ConnectorKey): number | null {
  return getNumberSetting(lastSyncKey(key));
}

export function setLastSyncAt(
  key: ConnectorKey,
  at: number = Math.floor(Date.now() / 1000),
): void {
  setSetting(lastSyncKey(key), String(at));
}

export function getCursor(key: ConnectorKey): string | null {
  const raw = getSetting(cursorKey(key));
  return raw && raw.length > 0 ? raw : null;
}

export function setCursor(key: ConnectorKey, cursor: string): void {
  setSetting(cursorKey(key), cursor);
}

/** Clear both watermarks so the next collect does a full backfill. */
export function resetWatermark(key: ConnectorKey): void {
  setSetting(lastSyncKey(key), "");
  setSetting(cursorKey(key), "");
}

/**
 * True when the connector's TTL has expired (or it has never run).
 * `force` short-circuits for the "refresh now" button.
 */
export function isStale(
  key: ConnectorKey,
  ttlMs: number,
  now: Date = new Date(),
): boolean {
  const last = getLastSyncAt(key);
  if (last === null) return true;
  return now.getTime() - last * 1000 >= ttlMs;
}
