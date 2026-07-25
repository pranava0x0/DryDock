import {
  latestQuotaSnapshots,
  quotaAgeSeconds,
  recordQuotaSnapshot,
  type QuotaSnapshot,
} from "../db/quota";
import type { UsageProvider } from "../db/usage";
import { readClaudeQuota } from "./quota-claude";
import { readCodexQuota } from "./quota-codex";

/**
 * Quota collection across providers (EP-10 Spec D).
 *
 * ── Google is deliberately absent ───────────────────────────────────────
 * There is no sanctioned machine surface for Google AI Pro quota —
 * Antigravity's `/usage` is a TUI panel, and no local file carries a
 * percentage. So DryDock renders the qualitative cap semantics from the
 * subscription registry and *no number at all*. Inventing a Google
 * percentage to make the three cards look symmetrical would be the
 * clearest possible case of a confident wrong value.
 *
 * ── Freshness is part of the value ──────────────────────────────────────
 * A quota reading without its age is misleading: "58%" from Monday shown
 * on Thursday reads as current. `quotaStatus` therefore returns the age
 * with every snapshot and marks anything past `STALE_AFTER_S` as stale so
 * the UI can grey it out. The Codex CLI does the same thing when its own
 * endpoint is rate-limited.
 */

/** Past this, a reading is shown as stale rather than current. */
export const STALE_AFTER_S = 30 * 60;

/** Don't re-spawn the app-server on every dashboard read. */
export const QUOTA_TTL_MS = 5 * 60 * 1000;

export interface QuotaCollectResult {
  provider: UsageProvider;
  status: "ok" | "unavailable";
  reason: string | null;
  snapshotsWritten: number;
}

let inFlight: Promise<QuotaCollectResult[]> | null = null;
let lastCollectAt = 0;

/**
 * Refresh quota snapshots for every provider that has a sanctioned local
 * surface. Never rejects — one provider's failure is another's normal
 * Tuesday, and neither should blank the dashboard.
 */
export async function collectQuotas(
  opts: { force?: boolean; now?: Date } = {},
): Promise<QuotaCollectResult[]> {
  const now = opts.now ?? new Date();
  if (!opts.force && now.getTime() - lastCollectAt < QUOTA_TTL_MS) {
    return [];
  }
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const results = await Promise.all([
        collectCodex(now),
        collectClaude(now),
      ]);
      lastCollectAt = now.getTime();
      return results;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

async function collectCodex(now: Date): Promise<QuotaCollectResult> {
  const capturedAt = Math.floor(now.getTime() / 1000);
  const result = await readCodexQuota();
  if (result.status !== "ok") {
    return {
      provider: "codex",
      status: "unavailable",
      reason: result.reason,
      snapshotsWritten: 0,
    };
  }
  let written = 0;
  for (const window of result.windows) {
    // A window the server reported but couldn't quantify is still worth
    // recording: it carries the reset time, and a null percentage is a
    // meaningful "we asked and it didn't say".
    recordQuotaSnapshot({
      provider: "codex",
      window: window.window,
      used_pct: window.usedPct,
      resets_at: window.resetsAt,
      source: "app-server",
      captured_at: capturedAt,
    });
    written += 1;
  }
  return {
    provider: "codex",
    status: "ok",
    reason: null,
    snapshotsWritten: written,
  };
}

async function collectClaude(now: Date): Promise<QuotaCollectResult> {
  const capturedAt = Math.floor(now.getTime() / 1000);
  const result = await readClaudeQuota();
  if (result.status !== "ok") {
    return {
      provider: "claude",
      status: "unavailable",
      reason: result.reason,
      snapshotsWritten: 0,
    };
  }
  let written = 0;
  const windows: Array<["5h" | "week", number | null, number | null]> = [
    ["5h", result.fiveHourUsedPct, result.fiveHourResetsAt],
    ["week", result.weeklyUsedPct, result.weeklyResetsAt],
  ];
  for (const [window, pct, resets] of windows) {
    // Only record a window the cache actually described. Writing a
    // null-everything row would put a permanent "unknown" chip on the
    // card that never resolves.
    if (pct === null && resets === null) continue;
    recordQuotaSnapshot({
      provider: "claude",
      window,
      used_pct: pct,
      resets_at: resets,
      source: "stats-cache",
      captured_at: capturedAt,
    });
    written += 1;
  }
  return {
    provider: "claude",
    status: written > 0 ? "ok" : "unavailable",
    reason:
      written > 0
        ? null
        : "stats-cache.json had no window percentages or reset times",
    snapshotsWritten: written,
  };
}

export interface QuotaView extends QuotaSnapshot {
  ageSeconds: number;
  stale: boolean;
}

/**
 * Latest snapshot per (provider, window), each with its age. This is what
 * the Usage tab and the digest read — never the raw table, so nobody can
 * accidentally render a percentage without its freshness.
 */
export function quotaStatus(
  provider?: UsageProvider,
  now: number = Math.floor(Date.now() / 1000),
): QuotaView[] {
  return latestQuotaSnapshots(provider).map((snapshot) => {
    const ageSeconds = quotaAgeSeconds(snapshot, now);
    return { ...snapshot, ageSeconds, stale: ageSeconds > STALE_AFTER_S };
  });
}

/** Test seam for the module-level TTL. */
export function _resetQuotaCollectorForTests(): void {
  inFlight = null;
  lastCollectAt = 0;
}
