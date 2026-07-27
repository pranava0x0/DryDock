import {
  latestUsageDay,
  replaceUsageDailyRange,
  replaceUsageHourlyRange,
  type UsageDailyRow,
  type UsageHourlyRow,
  type UsageProvider,
} from "../db/usage";
import { dayKeyOffset, parseDayKey } from "../util/day";
import { scanClaudeSessions } from "./claude-scan";
import { scanCodexSessions } from "./codex-scan";
import { scanAntigravityActivity } from "./antigravity-scan";
import {
  getCursor,
  getLastSyncAt,
  isStale,
  setCursor,
  setLastSyncAt,
} from "./watermark";
import {
  LOCAL_TTL_MS,
  type CollectResult,
  type Connector,
  type ConnectorHealth,
  type ConnectorKey,
  type ConnectorStatus,
} from "./types";

/**
 * The three local-file usage connectors (EP-10 Spec A).
 *
 * Each wraps a scanner in the same incremental-collect shape:
 *
 *   1. TTL check (shared in-process mutex, so concurrent readers of
 *      `/api/usage` share one disk walk instead of racing).
 *   2. Resume from the watermark cursor — a day key meaning "recompute
 *      from here forward". Absent cursor = full backfill.
 *   3. Scan, then atomically REPLACE that provider's rows from the cursor
 *      day onward (see lib/db/usage.ts for why replace, not upsert).
 *   4. Advance the cursor to *yesterday* and stamp last_sync_at.
 *
 * Step 3 is only sound because of the mtime pre-filter's guarantee: a
 * file last written before the cursor day cannot contain a turn on or
 * after it, so "everything from the cursor forward" really was recomputed
 * in full. Change the pre-filter and this stops being true.
 *
 * `last_sync_at` is stamped only after the write succeeds — same rule as
 * the Apple Notes sync. A half-finished collect leaves the older,
 * honest freshness in place.
 */

/**
 * Day key used when there is no cursor yet. Predates every provider's
 * existence, so the first collect walks everything once.
 */
const EPOCH_DAY = "1970-01-01";

interface ScanOutcome {
  daily: UsageDailyRow[];
  hourly: UsageHourlyRow[];
  itemsScanned: number;
  rootMissing: boolean;
}

interface UsageConnectorSpec {
  key: ConnectorKey;
  label: string;
  provider: UsageProvider;
  /** Explains an `unavailable` result in the user's terms. */
  missingReason: string;
  scan(since: Date): Promise<ScanOutcome>;
}

/** Last in-process outcome per connector, for `health()` without a re-scan. */
const lastOutcome = new Map<ConnectorKey, { status: ConnectorStatus; reason: string | null }>();

/** One in-flight collect per connector; concurrent callers share it. */
const inFlight = new Map<ConnectorKey, Promise<CollectResult>>();

function makeUsageConnector(spec: UsageConnectorSpec): Connector {
  const collectOnce = async (now: Date): Promise<CollectResult> => {
    const startedAt = Date.now();
    const cursor = getCursor(spec.key);
    const fromDay = cursor ?? EPOCH_DAY;
    // Local midnight of the cursor day. The scanners compare turn
    // timestamps against this, and mayContainRecentTurns applies its own
    // 12h safety margin on top when deciding which files to open.
    const since = parseDayKey(fromDay) ?? new Date(0);

    const outcome = await spec.scan(since);

    if (outcome.rootMissing) {
      // Nothing to write, and crucially nothing to DELETE: a provider
      // that isn't installed must not wipe history collected back when
      // it was. Leave the ledger and the cursor exactly as they were.
      const result: CollectResult = {
        key: spec.key,
        status: "unavailable",
        reason: spec.missingReason,
        rowsWritten: 0,
        itemsScanned: 0,
        durationMs: Date.now() - startedAt,
        skipped: false,
      };
      lastOutcome.set(spec.key, { status: result.status, reason: result.reason });
      return result;
    }

    const rowsWritten = replaceUsageDailyRange(
      spec.provider,
      "cli",
      fromDay,
      outcome.daily,
    );
    replaceUsageHourlyRange(spec.provider, fromDay, outcome.hourly);

    // Yesterday, not today: a turn at 23:59:58 can be flushed to disk
    // after midnight, so freezing the cursor at today would clip the
    // tail of a late night out of the record permanently.
    setCursor(spec.key, dayKeyOffset(now, 1));
    setLastSyncAt(spec.key, Math.floor(now.getTime() / 1000));

    // Health describes the SOURCE, not this incremental slice. An
    // incremental collect resuming from yesterday's cursor legitimately
    // produces zero rows whenever the user didn't touch that provider
    // today — reporting "no-data" for that put a ⚠ badge on a Codex card
    // showing 312M tokens. So: ask the ledger whether this provider has
    // ever produced anything, and only then say no-data.
    const everProduced = latestUsageDay(spec.provider) !== null;
    const status: ConnectorStatus = everProduced ? "ok" : "no-data";
    const reason = everProduced
      ? null
      : "source is present but has never recorded any activity";
    lastOutcome.set(spec.key, { status, reason });
    return {
      key: spec.key,
      status,
      reason,
      rowsWritten,
      itemsScanned: outcome.itemsScanned,
      durationMs: Date.now() - startedAt,
      skipped: false,
    };
  };

  return {
    key: spec.key,
    label: spec.label,
    ttlMs: LOCAL_TTL_MS,

    async collect(opts = {}): Promise<CollectResult> {
      const now = opts.now ?? new Date();
      if (!opts.force && !isStale(spec.key, LOCAL_TTL_MS, now)) {
        const last = lastOutcome.get(spec.key);
        return {
          key: spec.key,
          status: last?.status ?? "ok",
          reason: last?.reason ?? null,
          rowsWritten: 0,
          itemsScanned: 0,
          durationMs: 0,
          skipped: true,
        };
      }
      const existing = inFlight.get(spec.key);
      if (existing) return existing;

      const run = (async () => {
        try {
          return await collectOnce(now);
        } finally {
          inFlight.delete(spec.key);
        }
      })();
      inFlight.set(spec.key, run);
      return run;
    },

    async health(): Promise<ConnectorHealth> {
      const last = lastOutcome.get(spec.key);
      const lastSyncAt = getLastSyncAt(spec.key);
      if (!last) {
        // Never collected in this process. Say so rather than guessing
        // "ok" — an unknown state and a healthy one look identical in a
        // chart, which is exactly the failure mode to avoid.
        return {
          key: spec.key,
          status: lastSyncAt === null ? "unavailable" : "ok",
          reason:
            lastSyncAt === null
              ? "not collected yet"
              : null,
          lastSyncAt,
        };
      }
      return {
        key: spec.key,
        status: last.status,
        reason: last.reason,
        lastSyncAt,
      };
    },
  };
}

/**
 * Source-directory override, same convention as `DRYDOCK_DB_PATH` and
 * `DRYDOCK_PROJECTS_ROOT`. Read at call time (not module load) so a test
 * can set it per case, and so a user pointing DryDock at a synced or
 * relocated home directory doesn't need a code change.
 */
function sourceDir(envVar: string): string | undefined {
  const value = process.env[envVar];
  return value && value.length > 0 ? value : undefined;
}

export const claudeLocalConnector = makeUsageConnector({
  key: "claude-local",
  label: "Claude Code (local logs)",
  provider: "claude",
  missingReason: "no ~/.claude/projects — Claude Code has not run on this Mac",
  scan: async (since) => {
    const result = await scanClaudeSessions(
      sourceDir("DRYDOCK_CLAUDE_PROJECTS_DIR"),
      since,
    );
    return {
      daily: result.daily,
      hourly: result.hourly,
      itemsScanned: result.filesScanned,
      rootMissing: result.rootMissing,
    };
  },
});

export const codexLocalConnector = makeUsageConnector({
  key: "codex-local",
  label: "OpenAI Codex (local logs)",
  provider: "codex",
  missingReason:
    "no ~/.codex/sessions or archived_sessions — the Codex CLI has not run on this Mac",
  scan: async (since) => {
    const result = await scanCodexSessions(
      sourceDir("DRYDOCK_CODEX_SESSIONS_DIR"),
      since,
    );
    return {
      daily: result.daily,
      hourly: result.hourly,
      itemsScanned: result.filesScanned,
      rootMissing: result.rootMissing,
    };
  },
});

export const antigravityLocalConnector = makeUsageConnector({
  key: "antigravity-local",
  label: "Google Antigravity (local logs)",
  provider: "google",
  missingReason:
    "no ~/.gemini/antigravity/brain — Antigravity has not run on this Mac",
  scan: async (since) => {
    const result = await scanAntigravityActivity(
      sourceDir("DRYDOCK_ANTIGRAVITY_BRAIN_DIR"),
      since,
      sourceDir("DRYDOCK_ANTIGRAVITY_CLI_DIR"),
    );
    return {
      daily: result.daily,
      hourly: result.hourly,
      itemsScanned: result.conversationsScanned,
      rootMissing: result.rootMissing,
    };
  },
});

/**
 * Record a failure that happened outside `collect()`'s own try — a throw
 * from the scanner or the ledger write that the registry caught.
 *
 * Without this, `collectUsage`'s catch built an `unavailable` result that
 * the background collector then discarded, leaving `health()` reading a
 * stale `ok` from the previous successful run. The card would keep
 * claiming everything was fine while refreshes silently failed (Codex,
 * PR #8).
 */
export function _recordConnectorFailure(
  key: ConnectorKey,
  reason: string,
): void {
  lastOutcome.set(key, { status: "unavailable", reason });
}

/**
 * Test seam: `health()` remembers the last outcome in module state so the
 * UI doesn't pay for a re-scan. Tests that assert the never-collected
 * branch need to clear it.
 */
export function _resetConnectorStateForTests(): void {
  lastOutcome.clear();
  inFlight.clear();
}
