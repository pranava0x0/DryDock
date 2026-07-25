/**
 * The connector family (EP-10 §4).
 *
 * A connector is a read-only gatherer: it reads something local (a
 * provider's session logs, the GitHub CLI's output) and writes rollup
 * rows into SQLite. One module + one registry line per source, so adding
 * a fourth provider log or a new export format is an additive change
 * rather than a rework.
 *
 * ── Cadence without a scheduler ─────────────────────────────────────────
 * EP-8's in-process scheduler hasn't shipped, so connectors run
 * **on-read with a TTL** — exactly how `/api/provider-budgets` already
 * works. `GET /api/usage` triggers a collect if the connector is stale.
 * Each connector holds an in-process mutex (the `inFlightSync` pattern)
 * so concurrent readers share one run instead of racing. No new
 * client-side auto-sync triggers: that rule in CLAUDE.md stands.
 *
 * ── Health is a first-class result, not an exception ────────────────────
 * "The gh CLI isn't authenticated" and "Codex has never run here" are
 * ordinary states, and the one thing they must never do is render as an
 * empty chart that reads like zero usage. Every connector reports
 * `health()` and the UI surfaces it. A connector that cannot answer says
 * so.
 */

export type ConnectorKey =
  | "claude-local"
  | "codex-local"
  | "antigravity-local"
  | "github"
  | "ideas-folder";

export const CONNECTOR_KEYS: readonly ConnectorKey[] = [
  "claude-local",
  "codex-local",
  "antigravity-local",
  "github",
  "ideas-folder",
] as const;

export function isConnectorKey(value: unknown): value is ConnectorKey {
  return (
    typeof value === "string" &&
    (CONNECTOR_KEYS as readonly string[]).includes(value)
  );
}

export type ConnectorStatus =
  /** Read succeeded and produced (or confirmed) data. */
  | "ok"
  /** Read succeeded; the source exists but has nothing in range. */
  | "no-data"
  /** The source isn't present or isn't reachable. Never rendered as zero. */
  | "unavailable";

export interface ConnectorHealth {
  key: ConnectorKey;
  status: ConnectorStatus;
  /** Human-readable explanation. Required for non-"ok". */
  reason: string | null;
  /** Unix seconds of the last successful collect, or null if never. */
  lastSyncAt: number | null;
}

export interface CollectResult {
  key: ConnectorKey;
  status: ConnectorStatus;
  reason: string | null;
  /** Ledger rows written this run. */
  rowsWritten: number;
  /** Source files/records examined — useful for "is this doing anything". */
  itemsScanned: number;
  /** Wall-clock of the collect, for the freshness footer. */
  durationMs: number;
  /** True when the TTL was still valid and no work was done. */
  skipped: boolean;
}

export interface Connector {
  key: ConnectorKey;
  /** Human label for the health chip. */
  label: string;
  /** How long a collect stays fresh. Local files are cheap; GitHub isn't. */
  ttlMs: number;
  /** Incremental via the connector's own watermark. */
  collect(opts?: { force?: boolean; now?: Date }): Promise<CollectResult>;
  health(): Promise<ConnectorHealth>;
}

/** Local-file connectors are cheap enough to re-run every minute. */
export const LOCAL_TTL_MS = 60 * 1000;
/** GitHub costs API budget and moves slower. */
export const GITHUB_TTL_MS = 5 * 60 * 1000;
