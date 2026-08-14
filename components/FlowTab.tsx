"use client";

import { useState } from "react";
import { Disclosure, InlineDisclosure } from "./Disclosure";
import { useCachedResource } from "./useCachedResource";

/**
 * Analytics → Flow (EP-11 Spec C).
 *
 * "How much am I actually shipping, and how much of it did an agent
 * write?" — answered from local git clones, private repos included.
 *
 * The binding rule here is that **every AI-share number renders its
 * trailer coverage**. A branch-name inference is not a measurement, and
 * a share quoted without its coverage claims a precision this data
 * doesn't have.
 */

type Agent = "human" | "claude" | "codex" | "jam" | "drydock" | "gemini";

interface FlowSummary {
  windowDays: number;
  fromDay: string;
  toDay: string;
  totalCommits: number;
  totalAdditions: number;
  totalDeletions: number;
  daily: Array<{ day: string; commits: number; additions: number; deletions: number }>;
  punchcard: Array<{ weekday: number; hour: number; commits: number }>;
  currentStreak: number;
  longestStreak: number;
  attribution: {
    totalCommits: number;
    byAgent: Array<{ agent: Agent; commits: number; additions: number; share: number }>;
    byModel: Array<{ agent: Agent; model: string; commits: number }>;
    trailerCoverage: number;
    aiShare: number;
  };
  repos: Array<{
    repo: string;
    commits: number;
    additions: number;
    deletions: number;
    aiShare: number;
    lastCommitDay: string | null;
  }>;
  reposRead: number;
  root: string;
  reason: string | null;
}

/** design.md palette — agents share the provider hues. */
const AGENT_COLOR: Record<Agent, string> = {
  human: "bg-kraken-ice/70",
  claude: "bg-violet-500/70",
  codex: "bg-teal-500/70",
  gemini: "bg-blue-500/70",
  jam: "bg-amber-400/70",
  drydock: "bg-kraken-shadow",
};

const AGENT_LABEL: Record<Agent, string> = {
  human: "you",
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
  jam: "jam",
  drydock: "DryDock",
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WINDOWS = [30, 90, 365] as const;

function fmt(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function FlowTab() {
  const [windowDays, setWindowDays] = useState<number>(90);

  /**
   * Cached per window, because the URL is the cache key: flipping
   * 30d → 90d → 30d re-reads nothing the second time.
   *
   * This is the tab that most needed it. The underlying git sweep is
   * 16–25s cold, and switching to Runs and back used to unmount this
   * component, throw the payload away, and re-request — landing on
   * "Reading your git history…" even though the server already had the
   * answer. The server's SWR made the *request* fast; only the client
   * cache stops the flash.
   *
   * A longer max-age than the default fits here: the window is 90 days of
   * git history, so a payload a couple of minutes old is not meaningfully
   * different from a fresh one.
   */
  const { data, error, loading, stale } = useCachedResource<FlowSummary>(
    `/api/flow?window=${windowDays}`,
    { maxAgeMs: 120_000 },
  );

  if (loading) {
    return (
      <p className="dd-pulse text-sm text-kraken-shadow">
        Reading your git history…
      </p>
    );
  }
  if (error && !data) {
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

  const ai = data.attribution;

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        {WINDOWS.map((days) => (
          <button
            key={days}
            type="button"
            onClick={() => setWindowDays(days)}
            className={`tap rounded-full px-3 text-xs font-medium transition ${
              windowDays === days
                ? "bg-kraken-ice text-kraken-deep"
                : "border border-kraken-boundless text-zinc-300 hover:bg-kraken-boundless/30"
            }`}
          >
            {days === 365 ? "1y" : `${days}d`}
          </button>
        ))}
        {/* Cached numbers are shown immediately; this says when they're
            being re-read, so a stale figure never passes as a live one. */}
        {stale ? (
          <span className="dd-pulse ml-auto self-center text-xs text-kraken-shadow">
            refreshing
          </span>
        ) : null}
      </div>

      {data.reason ? (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
          ⚠ {data.reason}
        </p>
      ) : null}

      {data.totalCommits === 0 ? (
        <div className="rounded-lg border border-dashed border-kraken-boundless p-8 text-center">
          <p aria-hidden="true" className="text-3xl">
            🏗️
          </p>
          <p className="mt-2 text-sm text-zinc-300">
            No commits in the last {data.windowDays} days.
          </p>
          <p className="mt-1 text-xs text-kraken-shadow">
            Read from git clones under {data.root}.
          </p>
        </div>
      ) : null}

      {data.totalCommits > 0 ? (
        <>
          {/* Headline — always open, spans full width at every size. */}
          <section className="rounded-lg border border-kraken-ice/30 bg-kraken-ice/[0.04] p-4">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-sm font-medium text-kraken-ice">
                🏗️ Shipped
              </h3>
              <span className="text-[11px] text-kraken-shadow">
                {data.reposRead} repo{data.reposRead === 1 ? "" : "s"}, private
                included
              </span>
            </div>

            <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div>
                <dt className="text-[10px] uppercase tracking-wide text-kraken-shadow">
                  commits
                </dt>
                <dd className="text-2xl font-semibold tabular-nums text-zinc-50">
                  {fmt(data.totalCommits)}
                </dd>
              </div>
              <div>
                <dt className="text-[10px] uppercase tracking-wide text-kraken-shadow">
                  streak
                </dt>
                <dd className="text-2xl font-semibold tabular-nums text-zinc-50">
                  {data.currentStreak}
                  <span className="ml-1 text-xs font-normal text-kraken-shadow">
                    d
                  </span>
                </dd>
              </div>
              <div>
                <dt className="text-[10px] uppercase tracking-wide text-kraken-shadow">
                  AI share
                </dt>
                <dd className="text-2xl font-semibold tabular-nums text-zinc-50">
                  {Math.round(ai.aiShare * 100)}%
                </dd>
              </div>
              <div>
                <dt className="text-[10px] uppercase tracking-wide text-kraken-shadow">
                  lines
                </dt>
                <dd className="text-2xl font-semibold tabular-nums text-emerald-300">
                  +{fmt(data.totalAdditions)}
                </dd>
              </div>
            </dl>

            <div className="mt-3">
              <div className="flex h-2.5 overflow-hidden rounded-full bg-kraken-boundless/30">
                {ai.byAgent.map((entry) => (
                  <div
                    key={entry.agent}
                    title={`${AGENT_LABEL[entry.agent]}: ${entry.commits} commits (${Math.round(entry.share * 100)}%)`}
                    className={AGENT_COLOR[entry.agent]}
                    style={{ width: `${Math.max(entry.share * 100, 0.5)}%` }}
                  />
                ))}
              </div>
              <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-kraken-shadow">
                {ai.byAgent.map((entry) => (
                  <li key={entry.agent}>
                    <span
                      aria-hidden="true"
                      className={`mr-1 inline-block h-2 w-2 rounded-full align-middle ${AGENT_COLOR[entry.agent]}`}
                    />
                    <span className="text-zinc-300">
                      {AGENT_LABEL[entry.agent]}
                    </span>{" "}
                    {Math.round(entry.share * 100)}%
                  </li>
                ))}
              </ul>
            </div>

            {/* The coverage chip. Never render a share without it. */}
            <p className="mt-2 text-[11px] leading-snug text-kraken-shadow">
              {Math.round(ai.trailerCoverage * 100)}% of agent commits carried
              an explicit co-author trailer; the rest were inferred from a
              branch name.
              {ai.trailerCoverage < 1
                ? " Treat the split as approximate."
                : ""}
            </p>

            <InlineDisclosure label="How is this worked out?">
              <p>
                Every commit in your local clones is checked for a{" "}
                <code>Co-Authored-By</code> trailer with a known agent
                address — <code>noreply@anthropic.com</code>,{" "}
                <code>noreply@openai.com</code>. The <em>domain</em> is what
                counts, not the name: your own co-author trailers from pair
                commits and rebases would otherwise inflate the AI share.
              </p>
              <p>
                A commit with no trailer falls back to its branch prefix
                (<code>claude/</code>, <code>jam/</code>,{" "}
                <code>drydock/</code>), which says which harness opened the
                branch — not that a machine wrote the commit. That&apos;s why
                coverage is reported separately.
              </p>
              <p>
                Merge commits are excluded: their diffstat double-counts both
                sides and they carry no trailer.
              </p>
            </InlineDisclosure>
          </section>

          {/* On tablet and desktop these three sit side by side rather
              than stacking into a long scroll. */}
          {/* `items-start` matters: grid items stretch to the row height by
              default, so a collapsed card sitting beside an open one grew a
              tall empty box under its summary. */}
          <div className="grid items-start gap-3 lg:grid-cols-2">
            <Disclosure
              title="Cadence"
              defaultOpen
              summary={`longest streak ${data.longestStreak}d`}
            >
              <DailyBars daily={data.daily} />
              <p className="mt-1 flex justify-between text-[10px] text-kraken-shadow">
                <span>{data.fromDay}</span>
                <span>{data.toDay}</span>
              </p>
            </Disclosure>

            <Disclosure
              title="Models"
              summary={
                ai.byModel.length > 0
                  ? `top ${ai.byModel[0].model}`
                  : "no model data"
              }
            >
              {ai.byModel.length === 0 ? (
                <p className="text-[11px] text-kraken-shadow">
                  No commit named a model. Older trailers didn&apos;t include
                  one.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {ai.byModel.slice(0, 8).map((entry) => (
                    <li
                      key={`${entry.agent}-${entry.model}`}
                      className="flex items-center gap-2"
                    >
                      <span className="w-24 shrink-0 truncate text-xs text-zinc-300">
                        {entry.model}
                      </span>
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-kraken-boundless/30">
                        <div
                          className={`h-full rounded-full ${AGENT_COLOR[entry.agent]}`}
                          style={{
                            width: `${Math.max((entry.commits / ai.byModel[0].commits) * 100, 1)}%`,
                          }}
                        />
                      </div>
                      <span className="w-10 shrink-0 text-right text-[11px] tabular-nums text-kraken-shadow">
                        {entry.commits}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Disclosure>

            <Disclosure title="Punch card" summary={peakLabel(data.punchcard)}>
              <p className="text-[11px] text-kraken-shadow">
                Commits by local hour and weekday.
              </p>
              <Punchcard cells={data.punchcard} />
            </Disclosure>

            <Disclosure
              title="Repos"
              summary={
                data.repos.length > 0
                  ? `${data.repos.length} active · top ${data.repos[0].repo}`
                  : "none"
              }
            >
              <ul className="space-y-1.5">
                {data.repos.slice(0, 10).map((repo) => (
                  <li key={repo.repo} className="flex items-center gap-2">
                    <span className="w-28 shrink-0 truncate text-xs text-zinc-300">
                      {repo.repo}
                    </span>
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-kraken-boundless/30">
                      {/* Two-tone: the agent slice sits inside the bar, so
                          a repo's AI share is legible without a second
                          chart. */}
                      <div
                        className="h-full rounded-full bg-kraken-ice/60"
                        style={{
                          width: `${Math.max((repo.commits / data.repos[0].commits) * 100, 1)}%`,
                        }}
                      >
                        <div
                          className="h-full rounded-full bg-violet-500/80"
                          style={{ width: `${repo.aiShare * 100}%` }}
                        />
                      </div>
                    </div>
                    <span className="w-14 shrink-0 text-right text-[11px] tabular-nums text-kraken-shadow">
                      {repo.commits}
                      <span className="ml-1 text-violet-300">
                        {Math.round(repo.aiShare * 100)}%
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </Disclosure>
          </div>

          <p className="text-[11px] leading-snug text-kraken-shadow">
            {data.fromDay} → {data.toDay} · read from git clones under{" "}
            <code>{data.root}</code>. Repos not cloned here aren&apos;t
            counted.
          </p>
        </>
      ) : null}
    </div>
  );
}

function peakLabel(
  cells: Array<{ weekday: number; hour: number; commits: number }>,
): string {
  if (cells.length === 0) return "no data";
  const peak = cells.reduce((best, c) => (c.commits > best.commits ? c : best));
  return `peaks ${WEEKDAYS[peak.weekday]} ${String(peak.hour).padStart(2, "0")}:00`;
}

function DailyBars({ daily }: { daily: FlowSummary["daily"] }) {
  const max = Math.max(...daily.map((d) => d.commits), 1);
  return (
    <div className="flex items-end gap-[2px]" style={{ height: 56 }}>
      {daily.map((day) => (
        <div
          key={day.day}
          title={`${day.day}: ${day.commits} commit${day.commits === 1 ? "" : "s"}, +${day.additions}/-${day.deletions}`}
          className={`flex-1 min-w-[2px] rounded-sm ${
            day.commits === 0 ? "bg-kraken-boundless/40" : "bg-kraken-ice/70"
          }`}
          style={{
            height: day.commits === 0 ? 3 : `${Math.max(8, (day.commits / max) * 100)}%`,
          }}
        />
      ))}
    </div>
  );
}

function Punchcard({
  cells,
}: {
  cells: Array<{ weekday: number; hour: number; commits: number }>;
}) {
  const byCell = new Map(cells.map((c) => [`${c.weekday}-${c.hour}`, c.commits]));
  const max = Math.max(...byCell.values(), 1);
  return (
    <div className="mt-2 overflow-x-auto">
      <div className="min-w-[380px]">
        {WEEKDAYS.map((name, weekday) => (
          <div key={name} className="flex items-center gap-1">
            <span className="w-8 shrink-0 text-[10px] text-kraken-shadow">
              {name}
            </span>
            <div className="flex flex-1 gap-[2px]">
              {Array.from({ length: 24 }, (_, hour) => {
                const value = byCell.get(`${weekday}-${hour}`) ?? 0;
                return (
                  <div
                    key={hour}
                    title={`${name} ${String(hour).padStart(2, "0")}:00 — ${value} commits`}
                    className="h-3 flex-1 rounded-[2px] bg-kraken-ice"
                    style={{
                      opacity: value === 0 ? 0.08 : 0.15 + (value / max) * 0.85,
                    }}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
