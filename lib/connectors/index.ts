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
