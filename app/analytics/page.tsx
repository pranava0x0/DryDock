"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { AnalyticsSummary } from "@/lib/db/analytics";
import { UsageTab } from "@/components/UsageTab";

/**
 * Analytics is three tabs (EP-10 Spec B): **Runs** is the original page,
 * unchanged; **Usage** is the all-provider ledger; **Flow** is EP-11's
 * GitHub view. One tap from anywhere in the PWA, no forms.
 *
 * The tab choice is remembered in sessionStorage — not localStorage:
 * "which tab was I on" is a property of this visit, and a month-old
 * preference reasserting itself is more surprising than useful.
 */
type Tab = "runs" | "usage" | "flow";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "runs", label: "Runs" },
  { id: "usage", label: "Usage" },
  { id: "flow", label: "Flow" },
];

const TAB_STORAGE_KEY = "drydock.analytics.tab";

function fmt$$(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function fmtDur(s: number | null): string {
  if (s === null) return "—";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

function pct(num: number, denom: number): string {
  if (denom === 0) return "—";
  return `${Math.round((num / denom) * 100)}%`;
}

function StatBox({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-lg border border-kraken-boundless bg-kraken-surface p-4">
      <dt className="text-xs uppercase tracking-wide text-kraken-shadow">
        {label}
      </dt>
      <dd className="mt-1 text-2xl font-semibold tabular-nums text-zinc-50">
        {value}
      </dd>
      {sub ? (
        <dd className="mt-0.5 text-xs text-kraken-shadow">{sub}</dd>
      ) : null}
    </div>
  );
}

function TrendGrid({ data }: { data: AnalyticsSummary["daily_trend"] }) {
  if (data.length === 0) {
    return (
      <p className="text-sm text-kraken-shadow">No runs in the last 30 days.</p>
    );
  }
  const maxRuns = Math.max(...data.map((d) => d.success + d.failed), 1);

  return (
    <div className="overflow-x-auto">
      <div className="flex min-w-0 items-end gap-[3px]" style={{ height: 64 }}>
        {data.map((tick) => {
          const total = tick.success + tick.failed;
          const heightPct = total === 0 ? 4 : Math.max(8, (total / maxRuns) * 100);
          const successFrac = total === 0 ? 0 : tick.success / total;
          const bg =
            total === 0
              ? "bg-kraken-boundless/40"
              : successFrac >= 0.8
                ? "bg-emerald-500/70"
                : successFrac >= 0.5
                  ? "bg-amber-400/70"
                  : "bg-kraken-alert/70";
          return (
            <div
              key={tick.date}
              title={`${tick.date}: ${tick.success} ok / ${tick.failed} fail`}
              className={`flex-1 min-w-[4px] rounded-sm ${bg} transition-all`}
              style={{ height: `${heightPct}%` }}
            />
          );
        })}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-kraken-shadow">
        <span>{data[0]?.date ?? ""}</span>
        <span>{data[data.length - 1]?.date ?? ""}</span>
      </div>
    </div>
  );
}

export default function AnalyticsPage() {
  const [tab, setTab] = useState<Tab>("runs");

  // Read after mount, never during render: sessionStorage doesn't exist
  // on the server, and reading it in the initial state would break the
  // hydration match.
  useEffect(() => {
    const stored = sessionStorage.getItem(TAB_STORAGE_KEY);
    if (stored === "runs" || stored === "usage" || stored === "flow") {
      setTab(stored);
    }
  }, []);

  const selectTab = (next: Tab): void => {
    setTab(next);
    sessionStorage.setItem(TAB_STORAGE_KEY, next);
  };

  return (
    <section>
      <div className="mb-4 flex items-baseline justify-between">
        <h1 className="text-xl font-semibold tracking-tight text-zinc-50">
          Analytics
        </h1>
        <Link
          href="/"
          className="text-xs text-kraken-ice underline-offset-2 transition hover:underline"
        >
          ← Dashboard
        </Link>
      </div>

      <div
        role="tablist"
        aria-label="Analytics views"
        className="mb-4 flex gap-2"
      >
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            onClick={() => selectTab(entry.id)}
            className={`min-h-[36px] rounded-full px-4 text-xs font-medium transition ${
              tab === entry.id
                ? "bg-kraken-ice text-kraken-deep"
                : "border border-kraken-boundless text-zinc-300 hover:bg-kraken-boundless/30"
            }`}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {tab === "runs" ? <RunsTab /> : null}
      {tab === "usage" ? <UsageTab /> : null}
      {tab === "flow" ? <FlowTab /> : null}
    </section>
  );
}

function FlowTab() {
  return (
    <div className="rounded-lg border border-dashed border-kraken-boundless p-8 text-center">
      <p aria-hidden="true" className="text-3xl">🏗️</p>
      <p className="mt-2 text-sm text-zinc-300">Code flow lands with EP-11.</p>
      <p className="mt-1 text-xs text-kraken-shadow">
        Commit and PR cadence across all repos, private included, with AI
        attribution.
      </p>
    </div>
  );
}

function RunsTab() {
  const [data, setData] = useState<AnalyticsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/analytics")
      .then((r) => r.json())
      .then((d: AnalyticsSummary) => setData(d))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <>
      {loading ? (
        <p className="text-sm text-kraken-shadow">loading…</p>
      ) : error ? (
        <p className="rounded-md border border-kraken-alert/30 bg-kraken-alert/10 px-3 py-2 text-sm text-kraken-alert">
          {error}
        </p>
      ) : data ? (
        <div className="space-y-6">
          {/* Summary stats */}
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatBox label="Total runs" value={String(data.total_runs)} />
            <StatBox
              label="Success rate"
              value={pct(data.success_runs, data.total_runs)}
              sub={`${data.success_runs} ok / ${data.failed_runs} failed`}
            />
            <StatBox
              label="Total cost"
              value={fmt$$(data.total_cost_usd)}
              sub="all time"
            />
            <StatBox
              label="Projects"
              value={String(data.per_project.length)}
              sub="with run history"
            />
          </dl>

          {/* 30-day trend */}
          <div className="rounded-lg border border-kraken-boundless bg-kraken-deep/40 p-4">
            <h2 className="mb-3 text-sm font-medium text-zinc-100">
              30-day activity
            </h2>
            <TrendGrid data={data.daily_trend} />
            <p className="mt-2 text-[11px] text-kraken-shadow">
              Green ≥ 80% success · amber 50–79% · red &lt; 50% · height = run
              volume
            </p>
          </div>

          {/* Failure breakdown */}
          {data.total_runs > 0 ? (
            <div className="rounded-lg border border-kraken-boundless bg-kraken-deep/40 p-4">
              <h2 className="mb-3 text-sm font-medium text-zinc-100">
                Failure breakdown
              </h2>
              {data.failed_runs === 0 ? (
                <p className="text-sm text-emerald-300">No failures. 🎉</p>
              ) : (
                <dl className="grid grid-cols-2 gap-3">
                  <div className="rounded-md border border-kraken-boundless/40 bg-kraken-surface p-3">
                    <dt className="text-xs uppercase tracking-wide text-kraken-shadow">
                      Gate failures
                    </dt>
                    <dd className="mt-1 text-xl font-semibold tabular-nums text-zinc-50">
                      {data.failure_breakdown.gate_failure}
                    </dd>
                    <dd className="text-xs text-kraken-shadow">
                      quality gate rejected
                    </dd>
                  </div>
                  <div className="rounded-md border border-kraken-boundless/40 bg-kraken-surface p-3">
                    <dt className="text-xs uppercase tracking-wide text-kraken-shadow">
                      Agent failures
                    </dt>
                    <dd className="mt-1 text-xl font-semibold tabular-nums text-zinc-50">
                      {data.failure_breakdown.agent_exit_failure}
                    </dd>
                    <dd className="text-xs text-kraken-shadow">
                      non-zero exit / timeout
                    </dd>
                  </div>
                </dl>
              )}
            </div>
          ) : null}

          {/* Per-project table */}
          {data.per_project.length > 0 ? (
            <div className="rounded-lg border border-kraken-boundless bg-kraken-deep/40 p-4">
              <h2 className="mb-3 text-sm font-medium text-zinc-100">
                Per-project breakdown
              </h2>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-kraken-boundless/40 text-left text-kraken-shadow">
                      <th className="pb-2 pr-4 font-medium">Project</th>
                      <th className="pb-2 pr-4 font-medium text-right">
                        Runs
                      </th>
                      <th className="pb-2 pr-4 font-medium text-right">
                        Success
                      </th>
                      <th className="pb-2 pr-4 font-medium text-right">
                        p50
                      </th>
                      <th className="pb-2 pr-4 font-medium text-right">
                        p90
                      </th>
                      <th className="pb-2 font-medium text-right">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.per_project.map((p) => (
                      <tr
                        key={p.project_id}
                        className="border-b border-kraken-boundless/20 last:border-0"
                      >
                        <td className="py-2 pr-4 font-medium text-zinc-200 truncate max-w-[140px]">
                          {p.project_name}
                        </td>
                        <td className="py-2 pr-4 tabular-nums text-right text-zinc-300">
                          {p.total_runs}
                        </td>
                        <td
                          className={`py-2 pr-4 tabular-nums text-right ${
                            p.failed_runs === 0
                              ? "text-emerald-300"
                              : p.success_runs / p.total_runs >= 0.5
                                ? "text-amber-300"
                                : "text-kraken-alert"
                          }`}
                        >
                          {pct(p.success_runs, p.total_runs)}
                        </td>
                        <td className="py-2 pr-4 tabular-nums text-right text-zinc-400">
                          {fmtDur(p.p50_duration_s)}
                        </td>
                        <td className="py-2 pr-4 tabular-nums text-right text-zinc-400">
                          {fmtDur(p.p90_duration_s)}
                        </td>
                        <td className="py-2 tabular-nums text-right text-zinc-300">
                          {fmt$$(p.total_cost_usd)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          {data.total_runs === 0 ? (
            <p className="text-sm text-kraken-shadow">
              No runs yet — dispatch your first task to see analytics here.
            </p>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
