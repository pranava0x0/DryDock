import type { CollectResult, Connector, ConnectorHealth, ConnectorKey } from "./types";
import {
  antigravityLocalConnector,
  claudeLocalConnector,
  codexLocalConnector,
} from "./usage-connectors";

/**
 * Connector registry — the `lib/providers/index.ts` pattern: a typed key
 * union, a `REGISTRY` map, and a guard. Adding a source is one module and
 * one line here.
 *
 * Only the usage connectors are registered today; `github` and
 * `ideas-folder` are declared in the key union (EP-11 / EP-14) so the
 * watermark keyspace and the health UI are already shaped for them.
 */
const REGISTRY: Partial<Record<ConnectorKey, Connector>> = {
  "claude-local": claudeLocalConnector,
  "codex-local": codexLocalConnector,
  "antigravity-local": antigravityLocalConnector,
};

/** Connectors that feed the usage ledger, in display order. */
export const USAGE_CONNECTORS: readonly Connector[] = [
  claudeLocalConnector,
  codexLocalConnector,
  antigravityLocalConnector,
] as const;

export function getConnector(key: ConnectorKey): Connector | null {
  return REGISTRY[key] ?? null;
}

export function registeredConnectors(): Connector[] {
  return Object.values(REGISTRY).filter((c): c is Connector => Boolean(c));
}

/**
 * Refresh every usage connector, honouring each one's TTL.
 *
 * Runs them concurrently and **never rejects**: one provider's failure
 * must not blank the other two's cards. A thrown error becomes an
 * `unavailable` result carrying its message, which is what the health
 * chip renders.
 */
export async function collectUsage(
  opts: { force?: boolean; now?: Date } = {},
): Promise<CollectResult[]> {
  return Promise.all(
    USAGE_CONNECTORS.map(async (connector) => {
      try {
        return await connector.collect(opts);
      } catch (err) {
        return {
          key: connector.key,
          status: "unavailable" as const,
          reason: (err as Error).message || "collect failed",
          rowsWritten: 0,
          itemsScanned: 0,
          durationMs: 0,
          skipped: false,
        };
      }
    }),
  );
}

/**
 * True while a collect started by `collectUsageInBackground` is still
 * running, so a caller can tell "the ledger is empty" apart from "the
 * ledger is still filling".
 */
let backgroundCollect: Promise<CollectResult[]> | null = null;

export function isCollecting(): boolean {
  return backgroundCollect !== null;
}

/**
 * Start a collect without waiting for it, and answer from whatever the
 * ledger already holds.
 *
 * Why this exists: the first collect on this machine took **83 seconds**
 * — 270 Claude session logs totalling well over a gigabyte, and the mtime
 * pre-filter can't skip them because they're all recent. Awaiting that
 * inside a page load means the Usage tab spins for a minute and a half
 * with nothing on screen, and a phone on a flaky tunnel gives up long
 * before it finishes.
 *
 * So the dashboard reads what's there and says what's happening. A cold
 * ledger shows "still reading your logs" rather than a fake zero; a warm
 * one renders instantly while the refresh happens behind it. The
 * connectors' own mutex means a second page load joins the running walk
 * instead of starting another.
 *
 * Errors are swallowed deliberately: nobody is awaiting this promise, so
 * an unhandled rejection here would be a process-level crash in exchange
 * for information the next `health()` call reports anyway.
 */
export function collectUsageInBackground(
  opts: { force?: boolean; now?: Date } = {},
): void {
  if (backgroundCollect) return;
  backgroundCollect = collectUsage(opts)
    .catch((): CollectResult[] => [])
    .finally(() => {
      backgroundCollect = null;
    }) as Promise<CollectResult[]>;
}

/** True when no connector has ever completed a collect. */
export async function hasCollectedEver(): Promise<boolean> {
  const health = await usageHealth();
  return health.some((h) => h.lastSyncAt !== null);
}

export async function usageHealth(): Promise<ConnectorHealth[]> {
  return Promise.all(USAGE_CONNECTORS.map((c) => c.health()));
}

export type { CollectResult, Connector, ConnectorHealth, ConnectorKey };
export {
  CONNECTOR_KEYS,
  isConnectorKey,
  LOCAL_TTL_MS,
  GITHUB_TTL_MS,
} from "./types";
