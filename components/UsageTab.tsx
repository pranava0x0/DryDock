"use client";

import { useEffect, useState } from "react";
import { Disclosure, InlineDisclosure } from "./Disclosure";

/**
 * Analytics → Usage (EP-10 Spec B).
 *
 * Answers the subscription question from local data alone: how much,
 * which models, which projects, when, and how close to the caps.
 *
 * Charts are CSS per design.md — no chart library. The honesty rules that
 * matter here, all enforced in markup below:
 *   - Google renders "activity", never tokens (`tokensAreReal`).
 *   - A provider with no data shows its connector's reason, not a zero bar.
 *   - A quota percentage always renders its age.
 *   - Value estimates render their pricing coverage.
 */

type ProviderKey = "claude" | "codex" | "google";

interface ConnectorHealth {
  key: string;
  status: "ok" | "no-data" | "unavailable";
  reason: string | null;
  lastSyncAt: number | null;
}

interface Slice {
  key: string;
  total_tokens: number;
  events: number;
  turns: number;
  sessions: number;
  share: number;
}

interface QuotaView {
  provider: ProviderKey;
  window: "5h" | "week" | "week_sonnet";
  used_pct: number | null;
  resets_at: number | null;
  source: string;
  captured_at: number;
  ageSeconds: number;
  stale: boolean;
}

interface Subscription {
  provider: ProviderKey;
  plan_name: string | null;
  price_usd_month: number | null;
  renewal_day: number | null;
  cap_notes: string | null;
  source: string;
}

interface ValueEstimate {
  usd: number;
  pricedTokens: number;
  unpricedTokens: number;
  coverage: number;
  asOf: string;
}

interface ProviderUsage {
  provider: ProviderKey;
  label: string;
  tokensAreReal: boolean;
  totals: {
    total_tokens: number;
    input_tokens: number;
    cached_tokens: number;
    output_tokens: number;
    turns: number;
    events: number;
    sessions: number;
    days: number;
  };
  daily: Array<{ day: string; totalTokens: number; events: number; turns: number }>;
  modelMix: Slice[];
  projects: Slice[];
  value: ValueEstimate | null;
  health: ConnectorHealth | null;
  quota: QuotaView[];
  subscription: Subscription | null;
  capNotes: string;
}

interface FleetTotals {
  totalTokens: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  turns: number;
  sessions: number;
  events: number;
  activeDays: number;
  tokenProviders: ProviderKey[];
  activityOnlyProviders: ProviderKey[];
  split: Array<{ provider: ProviderKey; label: string; tokens: number; share: number }>;
  value: ValueEstimate;
}

interface UsageSummary {
  windowDays: number;
  fromDay: string;
  toDay: string;
  fleet: FleetTotals;
  providers: ProviderUsage[];
  rhythm: Array<{ weekday: number; hour: number; turns: number; events: number }>;
  projects: Slice[];
  latestDay: string | null;
  unpricedNote: string;
  generatedAt: string;
  /** A collect is walking the logs right now. */
  collecting: boolean;
  /** False until the very first collect completes — a cold ledger. */
  everCollected: boolean;
}

/** design.md provider palette. Teal for Codex — see the "why not emerald" note. */
const ACCENT: Record<ProviderKey, string> = {
  claude: "bg-violet-500/70",
  codex: "bg-teal-500/70",
  google: "bg-blue-500/70",
};
const ACCENT_TEXT: Record<ProviderKey, string> = {
  claude: "text-violet-300",
  codex: "text-teal-300",
  google: "text-blue-300",
};

const WINDOWS = [7, 30, 90] as const;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function fmtTokens(n: number): string {
  if (n === 0) return "0";
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}

function fmtUsd(n: number): string {
  return n < 0.01 && n > 0 ? "<$0.01" : `$${n.toFixed(2)}`;
}

function fmtAge(seconds: number): string {
  if (seconds < 60) return "just now";
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** "unknown" is the honest label for an empty dimension — never a guess. */
function labelOrUnknown(key: string): string {
  return key.length === 0 ? "unknown" : key;
}

export function UsageTab() {
  const [data, setData] = useState<UsageSummary | null>(null);
  const [windowDays, setWindowDays] = useState<number>(30);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (days: number, force = false): Promise<void> => {
    try {
      const res = await fetch(
        `/api/usage?window=${days}${force ? "&force=1" : ""}`,
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to load usage");
      setData(body as UsageSummary);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  // Fetch on mount and whenever the window changes.
  useEffect(() => {
    void load(windowDays);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowDays]);

  // Re-check while a collect is walking the logs, and stop the moment it
  // finishes. This is NOT the auto-sync trigger CLAUDE.md rules out —
  // that rule is about firing repeated *work* (Apple Notes syncs) from
  // the client. Here the work is already running server-side and this
  // only reads its result; the interval exists solely so the first cold
  // collect (~83s here) lands on screen without the user tapping
  // refresh, and it clears itself as soon as `collecting` goes false.
  useEffect(() => {
    if (!data?.collecting) return;
    const timer = setInterval(() => {
      void load(windowDays);
    }, 5_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.collecting, windowDays]);

  if (loading) {
    return <p className="text-sm text-kraken-shadow">Reading local logs…</p>;
  }
  if (error) {
    return (
      <p
        role="alert"
        className="rounded-md border border-kraken-alert/30 bg-kraken-alert/10 px-3 py-2 text-sm text-kraken-alert"
      >
        {error}
      </p>
    );
  }
  if (!data) return null;

  const anyData = data.providers.some(
    (p) => p.totals.total_tokens > 0 || p.totals.events > 0,
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-2">
          {WINDOWS.map((days) => (
            <button
              key={days}
              type="button"
              onClick={() => setWindowDays(days)}
              className={`min-h-[36px] rounded-full px-3 text-xs font-medium transition ${
                windowDays === days
                  ? "bg-kraken-ice text-kraken-deep"
                  : "border border-kraken-boundless text-zinc-300 hover:bg-kraken-boundless/30"
              }`}
            >
              {days}d
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => {
            setRefreshing(true);
            void load(windowDays, true);
          }}
          disabled={refreshing}
          className="min-h-[36px] rounded-md border border-kraken-boundless px-3 text-xs text-zinc-300 transition hover:bg-kraken-boundless/30 disabled:opacity-50"
        >
          {refreshing ? "reading…" : "↻ Refresh"}
        </button>
      </div>

      {/* A cold ledger and an idle one look identical in a chart. Say
          which it is: "still reading" is not "you used nothing". */}
      {data.collecting ? (
        <p className="rounded-md border border-kraken-ice/30 bg-kraken-ice/5 px-3 py-2 text-xs text-kraken-ice">
          ⚙ Reading your local session logs
          {data.everCollected ? "" : " for the first time — this takes a minute"}
          . Numbers below fill in as it goes.
        </p>
      ) : null}

      {!anyData && !data.collecting ? (
        <div className="rounded-lg border border-dashed border-kraken-boundless p-8 text-center">
          <p aria-hidden="true" className="text-3xl">
            ⚓
          </p>
          <p className="mt-2 text-sm text-zinc-300">
            No usage recorded in the last {data.windowDays} days.
          </p>
          <p className="mt-1 text-xs text-kraken-shadow">
            The ledger fills from local CLI logs. Check each provider&rsquo;s
            status below.
          </p>
        </div>
      ) : null}

      <FleetCard fleet={data.fleet} providers={data.providers} />

      {data.providers.map((provider) => (
        <ProviderCard key={provider.provider} usage={provider} />
      ))}

      <RhythmCard rhythm={data.rhythm} />
      <ProjectsCard projects={data.projects} />

      <p className="text-[11px] leading-snug text-kraken-shadow">
        {data.fromDay} → {data.toDay} · every figure read from local files on
        this Mac; nothing leaves the machine. {data.unpricedNote}
      </p>
    </div>
  );
}

/**
 * All three subscriptions added together — the "how am I doing overall"
 * number, which no single provider card can answer.
 *
 * The one thing this card must never do is imply Google is in the token
 * total. Google records no tokens anywhere, so the total covers Claude +
 * Codex and says so, while turns and sessions genuinely span all three.
 */
function FleetCard({
  fleet,
  providers,
}: {
  fleet: FleetTotals;
  providers: ProviderUsage[];
}) {
  const labelFor = (key: ProviderKey): string =>
    providers.find((p) => p.provider === key)?.label ?? key;
  const activityOnly = fleet.activityOnlyProviders.map(labelFor);

  return (
    <section className="rounded-lg border border-kraken-ice/30 bg-kraken-ice/[0.04] p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium text-kraken-ice">
          ⚓ All services
        </h3>
        <span className="text-[11px] text-kraken-shadow">
          {fleet.activeDays} active day{fleet.activeDays === 1 ? "" : "s"}
        </span>
      </div>

      <dl className="mt-3 grid grid-cols-3 gap-3">
        <div>
          <dt className="text-[10px] uppercase tracking-wide text-kraken-shadow">
            tokens
          </dt>
          <dd className="text-2xl font-semibold tabular-nums text-zinc-50">
            {fmtTokens(fleet.totalTokens)}
          </dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-wide text-kraken-shadow">
            turns
          </dt>
          <dd className="text-2xl font-semibold tabular-nums text-zinc-50">
            {fmtTokens(fleet.turns)}
          </dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-wide text-kraken-shadow">
            sessions
          </dt>
          <dd className="text-2xl font-semibold tabular-nums text-zinc-50">
            {fmtTokens(fleet.sessions)}
          </dd>
        </div>
      </dl>

      {fleet.totalTokens > 0 ? (
        <div className="mt-3">
          <div className="flex h-2.5 overflow-hidden rounded-full bg-kraken-boundless/30">
            {fleet.split.map((part) => (
              <div
                key={part.provider}
                title={`${part.label}: ${fmtTokens(part.tokens)} tokens (${Math.round(part.share * 100)}%)`}
                className={ACCENT[part.provider]}
                style={{ width: `${Math.max(part.share * 100, 0.5)}%` }}
              />
            ))}
          </div>
          <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-kraken-shadow">
            {fleet.split.map((part) => (
              <li key={part.provider}>
                <span
                  aria-hidden="true"
                  className={`mr-1 inline-block h-2 w-2 rounded-full align-middle ${ACCENT[part.provider]}`}
                />
                <span className="text-zinc-300">{part.label}</span>{" "}
                {Math.round(part.share * 100)}%
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* The disclaimer that keeps the headline honest. */}
      {activityOnly.length > 0 ? (
        <p className="mt-2 text-[11px] leading-snug text-kraken-shadow">
          Token total covers {fleet.tokenProviders.map(labelFor).join(" + ")}.{" "}
          {activityOnly.join(" and ")} record{activityOnly.length === 1 ? "s" : ""}{" "}
          no token counts anywhere on disk, so {activityOnly.length === 1 ? "its" : "their"}{" "}
          {fmtTokens(fleet.events)} activity events sit outside it — turns and
          sessions above do include {activityOnly.length === 1 ? "it" : "them"}.
        </p>
      ) : null}

      {fleet.value.coverage > 0 ? (
        <p className="mt-2 text-[11px] leading-snug text-kraken-shadow">
          <span className="text-zinc-300">≈ {fmtUsd(fleet.value.usd)}</span> at
          API list prices ({fleet.value.asOf}) — an <em>estimate</em> of what
          this would have cost per-token, not what you paid.
          {fleet.value.coverage < 0.999
            ? ` Covers ${Math.round(fleet.value.coverage * 100)}% of tokens, so the real figure is higher.`
            : ""}
        </p>
      ) : null}

      <InlineDisclosure label="What's a turn? What's a token?">
        <p>
          <strong className="text-zinc-300">A token</strong> is roughly
          three-quarters of a word — the unit the models actually read and
          write, and the unit your plan&rsquo;s caps are measured in. The
          count here includes cache reads and writes, because those are real
          tokens the caps charge you for; leaving them out would understate a
          heavy Claude Code day by an order of magnitude.
        </p>
        <p>
          <strong className="text-zinc-300">A turn</strong> is one response
          from the model — one back-and-forth. A single question can cost one
          turn and a few hundred tokens, or one turn and a million, depending
          on how much context came along for the ride.
        </p>
        <p>
          <strong className="text-zinc-300">A session</strong> is one
          conversation: a `claude` invocation, a Codex rollout, an Antigravity
          conversation. Counted per day, so a session spanning midnight shows
          on both days.
        </p>
        <p>
          Watch <strong className="text-zinc-300">tokens</strong> when you want
          to know how close you are to a cap.{" "}
          <strong className="text-zinc-300">Turns</strong> is the better
          measure of how much you actually talked to the thing — it barely
          moves when a long file gets re-read, which is exactly when tokens
          spike.
        </p>
      </InlineDisclosure>
    </section>
  );
}

function ProviderCard({ usage }: { usage: ProviderUsage }) {
  const unhealthy = usage.health && usage.health.status !== "ok";
  const metricLabel = usage.tokensAreReal ? "tokens" : "activity events";
  const headline = usage.tokensAreReal
    ? fmtTokens(usage.totals.total_tokens)
    : fmtTokens(usage.totals.events);

  return (
    <Disclosure
      title={usage.label}
      accentClass={ACCENT_TEXT[usage.provider]}
      // The collapsed row still carries the headline and any health
      // warning, so you never have to expand just to learn whether
      // expanding is worth it.
      badge={
        unhealthy ? (
          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] text-amber-200 ring-1 ring-inset ring-amber-500/30">
            ⚠ no data
          </span>
        ) : null
      }
      summary={
        <>
          <span className="tabular-nums text-zinc-200">{headline}</span>{" "}
          {metricLabel} · {fmtTokens(usage.totals.turns)} turns
        </>
      }
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        {usage.subscription?.plan_name ? (
          <span className="text-[11px] text-kraken-shadow">
            {usage.subscription.plan_name}
            {usage.subscription.price_usd_month !== null
              ? ` · $${usage.subscription.price_usd_month}/mo`
              : ""}
          </span>
        ) : (
          <span className="text-[11px] text-kraken-shadow">
            plan not set — add it in Settings
          </span>
        )}
      </div>

      {/* Health first: a card whose source is unavailable must say so
          before showing any number, or the zeros below read as fact. */}
      {unhealthy ? (
        <p className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[11px] leading-snug text-amber-200">
          ⚠ {usage.health!.status === "unavailable" ? "No data source" : "No data in range"}
          {usage.health!.reason ? ` — ${usage.health!.reason}` : ""}
        </p>
      ) : null}

      <dl className="mt-3 grid grid-cols-3 gap-3">
        <div>
          <dt className="text-[10px] uppercase tracking-wide text-kraken-shadow">
            {metricLabel}
          </dt>
          <dd className="text-xl font-semibold tabular-nums text-zinc-50">
            {headline}
          </dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-wide text-kraken-shadow">
            turns
          </dt>
          <dd className="text-xl font-semibold tabular-nums text-zinc-50">
            {fmtTokens(usage.totals.turns)}
          </dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-wide text-kraken-shadow">
            active days
          </dt>
          <dd className="text-xl font-semibold tabular-nums text-zinc-50">
            {usage.totals.days}
          </dd>
        </div>
      </dl>

      <DailyTrend usage={usage} />

      {usage.quota.length > 0 ? (
        <div className="mt-3 space-y-1">
          {usage.quota.map((q) => (
            <QuotaRow key={`${q.provider}-${q.window}`} quota={q} />
          ))}
        </div>
      ) : (
        <p className="mt-3 text-[11px] leading-snug text-kraken-shadow">
          Cap usage %: not available locally. {usage.capNotes}
        </p>
      )}

      {/* A one-segment bar labelled "unknown 100%" is a chart that says
          nothing. Google records no model anywhere, so suppress the mix
          rather than render a placeholder. */}
      {usage.modelMix.length > 0 &&
      !(usage.modelMix.length === 1 && usage.modelMix[0].key === "") ? (
        <div className="mt-4">
          <h4 className="text-[11px] uppercase tracking-wide text-kraken-shadow">
            Model mix
          </h4>
          <div className="mt-1.5 flex h-2.5 overflow-hidden rounded-full bg-kraken-boundless/30">
            {usage.modelMix.map((slice, i) => (
              <div
                key={slice.key || `unknown-${i}`}
                title={`${labelOrUnknown(slice.key)}: ${Math.round(slice.share * 100)}%`}
                className={`${ACCENT[usage.provider]} ${i % 2 === 1 ? "opacity-60" : ""}`}
                style={{ width: `${Math.max(slice.share * 100, 0.5)}%` }}
              />
            ))}
          </div>
          <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-kraken-shadow">
            {usage.modelMix.slice(0, 5).map((slice) => (
              <li key={slice.key || "unknown"}>
                <span className="text-zinc-300">
                  {labelOrUnknown(slice.key)}
                </span>{" "}
                {Math.round(slice.share * 100)}%
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {usage.value ? <ValueRow value={usage.value} usage={usage} /> : null}
    </Disclosure>
  );
}

function DailyTrend({ usage }: { usage: ProviderUsage }) {
  const metric = (d: ProviderUsage["daily"][number]): number =>
    usage.tokensAreReal ? d.totalTokens : d.events;
  const max = Math.max(...usage.daily.map(metric), 1);

  return (
    <div className="mt-3">
      <div className="flex items-end gap-[2px]" style={{ height: 48 }}>
        {usage.daily.map((point) => {
          const value = metric(point);
          // Every day gets a bar. A zero day renders as a visible floor,
          // not as a gap — a gap reads as "chart ends here".
          const height = value === 0 ? 3 : Math.max(8, (value / max) * 100);
          return (
            <div
              key={point.day}
              title={`${point.day}: ${fmtTokens(value)} ${usage.tokensAreReal ? "tokens" : "events"}`}
              className={`flex-1 min-w-[2px] rounded-sm ${
                value === 0 ? "bg-kraken-boundless/40" : ACCENT[usage.provider]
              }`}
              style={{ height: value === 0 ? 3 : `${height}%` }}
            />
          );
        })}
      </div>
    </div>
  );
}

function QuotaRow({ quota }: { quota: QuotaView }) {
  const label = quota.window === "5h" ? "5-hour window" : "Weekly window";
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="w-24 shrink-0 text-kraken-shadow">{label}</span>
      {quota.used_pct === null ? (
        <span className="text-kraken-shadow">
          reported, but no percentage given
        </span>
      ) : (
        <>
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-kraken-boundless/30">
            <div
              className={`h-full rounded-full ${
                quota.used_pct >= 85
                  ? "bg-kraken-alert/80"
                  : quota.used_pct >= 60
                    ? "bg-amber-400/80"
                    : "bg-kraken-ice/80"
              }`}
              style={{ width: `${Math.min(100, Math.max(0, quota.used_pct))}%` }}
            />
          </div>
          <span className="tabular-nums text-zinc-200">
            {Math.round(quota.used_pct)}%
          </span>
        </>
      )}
      {/* A percentage without its age reads as current. Always show it,
          and grey the whole row out once it's stale. */}
      <span className={quota.stale ? "text-kraken-alert/80" : "text-kraken-shadow"}>
        {quota.stale ? "stale · " : ""}
        {fmtAge(quota.ageSeconds)}
      </span>
    </div>
  );
}

function ValueRow({
  value,
  usage,
}: {
  value: ValueEstimate;
  usage: ProviderUsage;
}) {
  const price = usage.subscription?.price_usd_month ?? null;

  // Zero coverage means "we have no price for any of these models", which
  // is a completely different statement from "this cost $0.00". Rendering
  // the dollar figure here would be the exact confident-wrong-value the
  // whole estimate is careful to avoid — so don't render one.
  if (value.coverage === 0) {
    return (
      <p className="mt-3 text-[11px] leading-snug text-kraken-shadow">
        No API-equivalent estimate: none of these models has a published list
        price ({fmtTokens(value.unpricedTokens)} tokens).
        {price !== null ? ` Plan costs $${price}/mo flat.` : ""}
      </p>
    );
  }

  return (
    <p className="mt-3 text-[11px] leading-snug text-kraken-shadow">
      <span className="text-zinc-300">≈ {fmtUsd(value.usd)}</span> at API list
      prices ({value.asOf})
      {price !== null ? ` vs $${price}/mo flat` : ""} — an <em>estimate</em> of
      what this usage would have cost per-token, not what you paid.
      {value.coverage < 0.999 ? (
        <>
          {" "}
          Covers {Math.round(value.coverage * 100)}% of tokens;{" "}
          {fmtTokens(value.unpricedTokens)} on models with no published price
          are excluded, so the real figure is higher.
        </>
      ) : null}
    </p>
  );
}

function RhythmCard({
  rhythm,
}: {
  rhythm: UsageSummary["rhythm"];
}) {
  const total = rhythm.reduce((sum, c) => sum + c.turns + c.events, 0);
  if (total === 0) return null;

  const byCell = new Map(
    rhythm.map((c) => [`${c.weekday}-${c.hour}`, c.turns + c.events]),
  );
  const max = Math.max(...byCell.values(), 1);

  // Surface the peak in the collapsed row: "when do I work" has a
  // one-line answer, and the grid is the evidence for it.
  const peak = rhythm.reduce(
    (best, cell) =>
      cell.turns + cell.events > best.turns + best.events ? cell : best,
    rhythm[0],
  );

  return (
    <Disclosure
      title="Rhythm"
      summary={`peaks ${WEEKDAYS[peak.weekday]} ${String(peak.hour).padStart(2, "0")}:00`}
    >
      <p className="text-[11px] text-kraken-shadow">
        Turns by local hour — when you actually work, across all providers.
      </p>
      <div className="mt-3 overflow-x-auto">
        <div className="min-w-[420px]">
          {WEEKDAYS.map((name, weekday) => (
            <div key={name} className="flex items-center gap-1">
              <span className="w-8 shrink-0 text-[10px] text-kraken-shadow">
                {name}
              </span>
              <div className="flex flex-1 gap-[2px]">
                {Array.from({ length: 24 }, (_, hour) => {
                  const value = byCell.get(`${weekday}-${hour}`) ?? 0;
                  const intensity = value === 0 ? 0 : 0.15 + (value / max) * 0.85;
                  return (
                    <div
                      key={hour}
                      title={`${name} ${String(hour).padStart(2, "0")}:00 — ${value} turns`}
                      className="h-3 flex-1 rounded-[2px] bg-kraken-ice"
                      style={{ opacity: intensity === 0 ? 0.08 : intensity }}
                    />
                  );
                })}
              </div>
            </div>
          ))}
          <div className="mt-1 flex justify-between pl-9 text-[10px] text-kraken-shadow">
            <span>00</span>
            <span>06</span>
            <span>12</span>
            <span>18</span>
            <span>23</span>
          </div>
        </div>
      </div>
    </Disclosure>
  );
}

function ProjectsCard({ projects }: { projects: Slice[] }) {
  const ranked = projects.filter((p) => p.total_tokens > 0).slice(0, 8);
  if (ranked.length === 0) return null;
  const max = Math.max(...ranked.map((p) => p.total_tokens), 1);

  return (
    <Disclosure
      title="Projects"
      summary={`${ranked.length} · top ${labelOrUnknown(ranked[0].key)}`}
    >
      <p className="text-[11px] text-kraken-shadow">
        By tokens, across providers. Worktrees count toward their parent
        project.
      </p>
      <ul className="mt-3 space-y-1.5">
        {ranked.map((project) => (
          <li key={project.key || "unknown"} className="flex items-center gap-2">
            <span className="w-28 shrink-0 truncate text-xs text-zinc-300">
              {labelOrUnknown(project.key)}
            </span>
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-kraken-boundless/30">
              <div
                className="h-full rounded-full bg-kraken-ice/70"
                style={{
                  width: `${Math.max((project.total_tokens / max) * 100, 1)}%`,
                }}
              />
            </div>
            <span className="w-12 shrink-0 text-right text-[11px] tabular-nums text-kraken-shadow">
              {fmtTokens(project.total_tokens)}
            </span>
          </li>
        ))}
      </ul>
    </Disclosure>
  );
}
