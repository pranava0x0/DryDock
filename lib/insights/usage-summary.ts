import {
  latestUsageDay,
  listUsageDaily,
  usageBy,
  usageRhythm,
  usageTotals,
  type RhythmCell,
  type UsageProvider,
  type UsageSlice,
  type UsageTotals,
} from "../db/usage";
import {
  getSubscription,
  DEFAULT_CAP_NOTES,
  type Subscription,
} from "../db/subscriptions";
import { quotaStatus, type QuotaView } from "../connectors/quota";
import { usageHealth } from "../connectors";
import type { ConnectorHealth, ConnectorKey } from "../connectors/types";
import { dayKeyOffset, dayKeyRange, localDayKey } from "../util/day";
import { estimateApiValue, KNOWN_UNPRICED_NOTE, type ValueEstimate } from "./api-prices";

/**
 * The Usage tab's payload (EP-10 Spec B), assembled from the ledger.
 *
 * ── The honesty rules this module enforces ──────────────────────────────
 * 1. **Google reports activity, not tokens.** Its `tokensAreReal` flag is
 *    false, and callers must render events/turns for it. Summing Google
 *    into a token total would make a busy month read as "you used Google
 *    for nothing".
 * 2. **A provider with no data says why.** Health comes from the
 *    connector, so an uninstalled CLI renders as "unavailable — Codex has
 *    not run here", never as a zero bar.
 * 3. **Value estimates carry their coverage.** Unpriced models drag
 *    `coverage` below 1 and the UI shows it beside the dollar figure.
 * 4. **Unknown model/project stay `''`.** The UI renders "unknown"; this
 *    module never substitutes a plausible name.
 * 5. **The daily trend is dense.** Days with no usage appear as explicit
 *    zeroes, so a gap reads as "nothing happened", not "chart ends here".
 */

export const PROVIDER_LABELS: Record<UsageProvider, string> = {
  claude: "Claude",
  codex: "OpenAI Codex",
  google: "Google AI",
};

const CONNECTOR_FOR: Record<UsageProvider, ConnectorKey> = {
  claude: "claude-local",
  codex: "codex-local",
  google: "antigravity-local",
};

export interface DailyPoint {
  day: string;
  totalTokens: number;
  events: number;
  turns: number;
}

export interface ProviderUsage {
  provider: UsageProvider;
  label: string;
  /**
   * False for Google: its rows carry activity counts and zeroed token
   * columns because no token data exists locally. Callers MUST branch on
   * this rather than rendering zeros as a token total.
   */
  tokensAreReal: boolean;
  totals: UsageTotals;
  daily: DailyPoint[];
  modelMix: Array<UsageSlice & { share: number }>;
  projects: Array<UsageSlice & { share: number }>;
  value: ValueEstimate | null;
  health: ConnectorHealth | null;
  quota: QuotaView[];
  subscription: Subscription | null;
  capNotes: string;
}

/**
 * Everything added up across all three subscriptions.
 *
 * ── Why the token total is not simply "all three" ───────────────────────
 * Google records no token counts anywhere on disk. Its ledger rows carry
 * activity events with zeroed token columns, so adding them to a token
 * sum contributes exactly nothing while implying Google was included —
 * a fleet total that silently means "Claude + Codex" is a wrong answer
 * wearing a right label. So `totalTokens` states which providers it
 * covers (`tokenProviders`) and `activityOnlyProviders` names the ones
 * whose work is real but unmeasurable in tokens. Turns and sessions DO
 * span all three, because every provider records those.
 */
export interface FleetTotals {
  /** Summed tokens across providers that actually report tokens. */
  totalTokens: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  /** Turns across ALL providers — every one of them records these. */
  turns: number;
  /** Session/conversation starts per day, summed. See UsageTotals.sessions. */
  sessions: number;
  /** Antigravity activity steps, kept separate from turns. */
  events: number;
  /** Distinct days with any activity from any provider. */
  activeDays: number;
  /** Providers contributing to `totalTokens`. */
  tokenProviders: UsageProvider[];
  /** Providers that record activity but no tokens (Google today). */
  activityOnlyProviders: UsageProvider[];
  /** Per-provider share of the token total, for the split bar. */
  split: Array<{ provider: UsageProvider; label: string; tokens: number; share: number }>;
  /** Combined API-equivalent value across token-reporting providers. */
  value: ValueEstimate;
}

export interface UsageSummary {
  windowDays: number;
  fromDay: string;
  toDay: string;
  /** All three services added together. */
  fleet: FleetTotals;
  providers: ProviderUsage[];
  rhythm: RhythmCell[];
  /** Cross-provider project totals, tokens descending. */
  projects: UsageSlice[];
  /** Null when the ledger is empty — the "no data yet" state. */
  latestDay: string | null;
  unpricedNote: string;
  generatedAt: string;
}

const PROVIDERS: UsageProvider[] = ["claude", "codex", "google"];

export interface UsageSummaryOptions {
  windowDays?: number;
  now?: Date;
}

export async function buildUsageSummary(
  options: UsageSummaryOptions = {},
): Promise<UsageSummary> {
  const now = options.now ?? new Date();
  // Clamped: an unbounded window would let a query string ask for a
  // 100-year dense trend array and blow up the response.
  const windowDays = clamp(options.windowDays ?? 30, 1, 730);
  const toDay = localDayKey(now);
  const fromDay = dayKeyOffset(now, windowDays - 1);
  const range = { fromDay, toDay };

  const health = await usageHealth();
  const healthByKey = new Map(health.map((h) => [h.key, h]));
  const allQuota = quotaStatus(undefined, Math.floor(now.getTime() / 1000));

  const providers = PROVIDERS.map((provider) =>
    buildProvider(provider, range, healthByKey, allQuota),
  );

  return {
    windowDays,
    fromDay,
    toDay,
    fleet: buildFleetTotals(providers, range),
    providers,
    rhythm: usageRhythm(range),
    projects: usageBy("project_key", range),
    latestDay: latestUsageDay(),
    unpricedNote: KNOWN_UNPRICED_NOTE,
    generatedAt: now.toISOString(),
  };
}

function buildFleetTotals(
  providers: ProviderUsage[],
  range: { fromDay: string; toDay: string },
): FleetTotals {
  const tokenProviders = providers.filter((p) => p.tokensAreReal);
  const activityOnly = providers.filter((p) => !p.tokensAreReal);

  const sum = (
    list: ProviderUsage[],
    pick: (t: ProviderUsage["totals"]) => number,
  ): number => list.reduce((acc, p) => acc + pick(p.totals), 0);

  const totalTokens = sum(tokenProviders, (t) => t.total_tokens);

  // Active days is a UNION across providers, not a sum: a day when the
  // user touched both Claude and Codex is one day of work, and adding
  // the per-provider counts would report 60 active days in a 30-day
  // window.
  const activeDays = new Set<string>();
  for (const provider of providers) {
    for (const point of provider.daily) {
      if (point.totalTokens > 0 || point.events > 0 || point.turns > 0) {
        activeDays.add(point.day);
      }
    }
  }

  // One estimate over every token-bearing row, so a model's own price is
  // applied to its own tokens rather than blending a fleet-wide rate.
  const value = estimateApiValue(
    listUsageDaily(range)
      .filter((row) => row.provider !== "google")
      .map((row) => ({
        model: row.model,
        input_tokens: row.input_tokens,
        cached_tokens: row.cached_tokens,
        output_tokens: row.output_tokens,
      })),
  );

  return {
    totalTokens,
    inputTokens: sum(tokenProviders, (t) => t.input_tokens),
    cachedTokens: sum(tokenProviders, (t) => t.cached_tokens),
    outputTokens: sum(tokenProviders, (t) => t.output_tokens),
    reasoningTokens: sum(tokenProviders, (t) => t.reasoning_tokens),
    // Turns and sessions span everything — all three providers record them.
    turns: sum(providers, (t) => t.turns),
    sessions: sum(providers, (t) => t.sessions),
    events: sum(providers, (t) => t.events),
    activeDays: activeDays.size,
    tokenProviders: tokenProviders.map((p) => p.provider),
    activityOnlyProviders: activityOnly.map((p) => p.provider),
    split: tokenProviders.map((p) => ({
      provider: p.provider,
      label: p.label,
      tokens: p.totals.total_tokens,
      share: totalTokens === 0 ? 0 : p.totals.total_tokens / totalTokens,
    })),
    value,
  };
}

function buildProvider(
  provider: UsageProvider,
  range: { fromDay: string; toDay: string },
  healthByKey: Map<ConnectorKey, ConnectorHealth>,
  allQuota: QuotaView[],
): ProviderUsage {
  const scope = { provider, ...range };
  const totals = usageTotals(scope);
  const tokensAreReal = provider !== "google";

  const byDay = new Map(
    usageBy("day", scope).map((slice) => [slice.key, slice]),
  );
  // Dense: every day in the window gets a point, so a quiet Sunday reads
  // as a zero rather than as the chart running out of data.
  const daily: DailyPoint[] = dayKeyRange(range.fromDay, range.toDay).map(
    (day) => {
      const slice = byDay.get(day);
      return {
        day,
        totalTokens: slice?.total_tokens ?? 0,
        events: slice?.events ?? 0,
        turns: slice?.turns ?? 0,
      };
    },
  );

  const modelMix = withShares(usageBy("model", scope), tokensAreReal);
  const projects = withShares(usageBy("project_key", scope), tokensAreReal);

  // Value framing only where tokens exist, and only from per-model rows —
  // a blended rate across models would be meaningless.
  const value = tokensAreReal
    ? estimateApiValue(
        listUsageDaily(scope).map((row) => ({
          model: row.model,
          input_tokens: row.input_tokens,
          cached_tokens: row.cached_tokens,
          output_tokens: row.output_tokens,
        })),
      )
    : null;

  const subscription = getSubscription(provider);

  return {
    provider,
    label: PROVIDER_LABELS[provider],
    tokensAreReal,
    totals,
    daily,
    modelMix,
    projects,
    value,
    health: healthByKey.get(CONNECTOR_FOR[provider]) ?? null,
    quota: allQuota.filter((q) => q.provider === provider),
    subscription,
    // Fall back to the seeded prose so the card can always explain how the
    // caps work, even before the user has entered a subscription.
    capNotes: subscription?.cap_notes ?? DEFAULT_CAP_NOTES[provider],
  };
}

/**
 * Attach each slice's share of the total. Shares are computed over the
 * metric that is actually real for the provider — tokens for Claude and
 * Codex, events for Google — so a Google model-mix bar isn't every
 * segment at 0%.
 */
function withShares(
  slices: UsageSlice[],
  tokensAreReal: boolean,
): Array<UsageSlice & { share: number }> {
  const metric = (s: UsageSlice): number =>
    tokensAreReal ? s.total_tokens : s.events;
  const total = slices.reduce((sum, s) => sum + metric(s), 0);
  return slices.map((slice) => ({
    ...slice,
    share: total === 0 ? 0 : metric(slice) / total,
  }));
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
