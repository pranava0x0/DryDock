"use client";

import { useEffect, useState } from "react";
import type { Overview, OverviewTodo } from "@/lib/insights/overview";

interface OverviewResponse extends Overview {
  cachedAt: string;
  refreshing?: boolean;
}

const compact = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

/**
 * A count, marked `30+` when it came back at the search limit.
 *
 * `gh search` caps each category, so a category sitting exactly on its cap is
 * a ceiling with an unknown remainder behind it — not a total. Null passes
 * through so the tile renders an em dash for "not read".
 */
function countLabel(value: number | null, truncated: boolean): string | null {
  if (value === null) return null;
  return truncated ? `${value}+` : String(value);
}

/**
 * The opener. Two questions, in order: what happened this week, and what is
 * waiting on you.
 *
 * The dashboard previously led with 30 project cards reading `0 pending / 0
 * active / 0 done` — thirty rows of zeros before any signal. Everything here
 * is a number that moves week to week, or a link you can act on.
 */
export function OpenerOverview() {
  const [data, setData] = useState<OverviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The server answers a stale request immediately with `refreshing: true`
    // and rebuilds behind it. A single mount fetch would therefore leave this
    // browser on the old numbers under a permanent "refreshing" label until
    // the user navigated — so poll back for the rebuilt payload. Bounded,
    // because a read that keeps reporting `refreshing` must not become an
    // endless poll.
    const REFRESH_POLL_MS = 3000;
    const MAX_FOLLOW_UPS = 10;

    const load = async (followUps: number): Promise<void> => {
      try {
        const res = await fetch("/api/overview");
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) throw new Error(body.error ?? "Failed to load overview");
        setData(body);
        setError(null);
        if (body.refreshing === true && followUps < MAX_FOLLOW_UPS) {
          timer = setTimeout(() => void load(followUps + 1), REFRESH_POLL_MS);
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load(0);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  if (loading) {
    return (
      <p className="dd-pulse mb-6 text-xs text-kraken-shadow">
        Reading this week&apos;s activity…
      </p>
    );
  }
  if (error) {
    return (
      <p
        className="mb-6 rounded-md border border-kraken-alert/30 bg-kraken-alert/10 px-3 py-2 text-sm text-kraken-alert"
        role="alert"
      >
        {error}
      </p>
    );
  }
  if (!data) return null;

  const { week, shipped, github, todos, todosUnavailable, staleCount } = data;

  return (
    <section className="mb-6">
      <div className="flex items-baseline justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight text-zinc-50">
          This week
        </h1>
        {data.refreshing ? (
          <span className="dd-pulse text-xs text-kraken-shadow">refreshing</span>
        ) : null}
      </div>

      {/* Top lines. Every tile is a live number; none of them is a zero that
          only means "nothing configured". */}
      <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <Stat
          label="commits"
          value={shipped.commits}
          sub={`${shipped.activeRepos} repo${shipped.activeRepos === 1 ? "" : "s"}`}
        />
        <Stat
          label="PRs merged"
          value={countLabel(shipped.pullsMerged, shipped.pullsMergedTruncated)}
          sub={
            shipped.pullsUnavailable
              ? "gh unavailable"
              : shipped.pullsOpened === null
                ? "opened: not read"
                : `${countLabel(shipped.pullsOpened, shipped.pullsOpenedTruncated)} opened`
          }
        />
        <Stat
          label="sessions"
          value={week?.sessions ?? null}
          sub={week ? `${compact.format(week.turns)} turns` : "no local logs"}
        />
        <Stat
          label="tokens out"
          value={week ? compact.format(week.outputTokens) : null}
          sub={week ? `${compact.format(week.cacheReadTokens)} cache read` : "—"}
        />
        <Stat
          label="open"
          value={
            // Only a real total when both halves were read. Adding a null to a
            // number would have quietly reported the surviving half as the sum.
            github.openPulls === null || github.openIssues === null
              ? null
              : countLabel(
                  github.openPulls + github.openIssues,
                  github.openPullsTruncated || github.openIssuesTruncated,
                )
          }
          sub={
            todosUnavailable
              ? "gh unavailable"
              : `${github.openPulls === null ? "—" : countLabel(github.openPulls, github.openPullsTruncated)} PRs · ${github.openIssues === null ? "—" : countLabel(github.openIssues, github.openIssuesTruncated)} issues`
          }
        />
      </dl>

      {!todosUnavailable && github.reason ? (
        // Partial failure: one of the two searches came back, one didn't. The
        // affected tile already shows an em dash; this says why.
        <p className="mt-2 text-xs text-kraken-shadow">{github.reason}</p>
      ) : null}

      {shipped.unreadableRepos > 0 ? (
        // Never let a partial read pass as a total.
        <p className="mt-2 text-xs text-kraken-shadow">
          {shipped.unreadableRepos} project
          {shipped.unreadableRepos === 1 ? "" : "s"} could not be read as a git
          repo — commit count excludes {shipped.unreadableRepos === 1 ? "it" : "them"}.
        </p>
      ) : null}

      {/* Top TODOs */}
      <h2 className="mt-6 text-sm font-medium text-zinc-200">Top TODOs</h2>
      {todosUnavailable ? (
        <p className="mt-1 text-xs text-kraken-shadow">
          {github.reason ?? "GitHub is unavailable"} — this list is empty
          because it could not be read, not because nothing is open.
        </p>
      ) : todos.length === 0 ? (
        <p className="mt-1 text-xs text-kraken-shadow">
          Nothing open. No PRs or issues assigned to you.
        </p>
      ) : (
        <>
          <ul className="mt-2 divide-y divide-kraken-boundless/60 rounded-lg border border-kraken-boundless">
            {todos.map((todo) => (
              <TodoRow key={todo.key} todo={todo} />
            ))}
          </ul>
          {staleCount > 0 ? (
            // Demoted, not dropped — say how many so the tail is visible.
            <p className="mt-2 text-xs text-kraken-shadow">
              Plus {staleCount} open item{staleCount === 1 ? "" : "s"} untouched
              for over 6 months, ranked below everything current.
            </p>
          ) : null}
        </>
      )}

      {/* Shipped — the commit/PR history behind the top lines. */}
      {shipped.recentMerged.length > 0 || shipped.byProject.length > 0 ? (
        <details className="mt-4 rounded-lg border border-kraken-boundless">
          <summary className="cursor-pointer px-3 py-2 text-sm text-kraken-ice">
            What shipped this week
          </summary>
          <div className="px-3 pb-3">
            {shipped.byProject.length > 0 ? (
              <>
                <p className="mt-1 text-xs uppercase tracking-wide text-kraken-shadow">
                  Commits by project
                </p>
                <ul className="mt-1 space-y-1">
                  {shipped.byProject.map((p) => (
                    <li key={p.path} className="text-xs text-zinc-300">
                      <span className="font-medium text-zinc-100">{p.name}</span>{" "}
                      <span className="text-kraken-shadow">
                        · {p.count} commit{p.count === 1 ? "" : "s"}
                      </span>
                      {p.subjects[0] ? (
                        <span className="block truncate text-kraken-shadow">
                          latest: {p.subjects[0]}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}

            {shipped.recentMerged.length > 0 ? (
              <>
                <p className="mt-3 text-xs uppercase tracking-wide text-kraken-shadow">
                  Merged PRs
                </p>
                <ul className="mt-1 space-y-1">
                  {shipped.recentMerged.map((pr) => (
                    <li key={`${pr.repository}#${pr.number}`} className="text-xs">
                      <a
                        href={pr.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-kraken-ice hover:underline"
                      >
                        {pr.repository}#{pr.number}
                      </a>{" "}
                      <span className="text-zinc-300">{pr.title}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}

            {shipped.pullsReason ? (
              <p className="mt-2 text-xs text-kraken-shadow">{shipped.pullsReason}</p>
            ) : null}
          </div>
        </details>
      ) : null}
    </section>
  );
}

function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  /** Null renders an em dash — an unread number must not look like zero. */
  value: number | string | null;
  sub: string;
}) {
  return (
    <div className="rounded-lg border border-kraken-boundless bg-kraken-deep/40 px-3 py-2">
      <dt className="text-xs text-kraken-shadow">{label}</dt>
      <dd className="mt-0.5 text-lg font-semibold text-zinc-50">
        {value === null ? <span className="text-kraken-shadow">—</span> : value}
      </dd>
      <dd className="text-xs text-kraken-shadow">{sub}</dd>
    </div>
  );
}

function TodoRow({ todo }: { todo: OverviewTodo }) {
  return (
    <li>
      <a
        href={todo.url}
        target="_blank"
        rel="noopener noreferrer"
        className="flex min-h-[44px] items-center gap-2 px-3 py-2 transition hover:bg-kraken-boundless/30"
      >
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
            todo.kind === "pr"
              ? "bg-kraken-ice/15 text-kraken-ice"
              : "bg-amber-300/15 text-amber-300"
          }`}
        >
          {todo.label}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-zinc-100">{todo.title}</span>
          <span className="block truncate text-xs text-kraken-shadow">
            {todo.repository}#{todo.number}
            {todo.ageDays !== null
              ? ` · ${todo.ageDays === 0 ? "today" : `${todo.ageDays}d ago`}`
              : ""}
          </span>
        </span>
      </a>
    </li>
  );
}
