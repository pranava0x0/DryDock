"use client";

import type { Overview, OverviewTodo } from "@/lib/insights/overview";
import type { NextUp } from "@/lib/insights/next-up";
import type { RecentSessionsResult } from "@/lib/connectors/recent-sessions.types";
import { useCachedResource } from "@/components/useCachedResource";
import { NextUpPanel } from "@/components/NextUp";
import { RecentSessions } from "@/components/RecentSessions";
import { Disclosure } from "@/components/Disclosure";

interface OverviewResponse extends Overview {
  cachedAt: string;
  refreshing?: boolean;
  recent: RecentSessionsResult;
  nextUp: NextUp;
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
  // Client-side SWR. The previous mount-fetch meant every trip back to the
  // dashboard tore this panel down to "Reading this week's activity…" and
  // re-fetched — the data was already known, the client was just throwing
  // it away on unmount. Now the last payload is kept outside React and
  // repainted on the first frame.
  const {
    data,
    error,
    loading,
    stale,
    refresh,
  } = useCachedResource<OverviewResponse>("/api/overview", {
    // The server answers a stale request immediately with `refreshing:
    // true` and rebuilds behind it, so come back for the rebuilt payload
    // rather than sitting on old numbers under a permanent label.
    shouldPoll: (body) => body.refreshing === true,
    // No sessionStorage for this one (Codex, PR #41). The payload now
    // carries `recent.sessions[].lastPrompt` — verbatim excerpts of what
    // the user typed into Claude Code, Codex and Antigravity. The reader
    // that produces them states that prompt text is never persisted, and
    // writing it to sessionStorage would have made that false: the text
    // would outlive the document and stay recoverable for the rest of the
    // browser session.
    //
    // The in-memory cache still applies, so navigating away and back is
    // still free — only surviving a reload is given up, and only for the
    // one payload that contains transcript text.
    persist: false,
  });

  if (loading) return <OpenerSkeleton />;

  if (error && !data) {
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
    <>
      {/* The recommendation leads. Everything below it is evidence. */}
      <NextUpPanel nextUp={data.nextUp} />

      <section className="mb-6">
      <div className="flex items-baseline justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight text-zinc-50">
          This week
        </h1>
        {/* `stale` is the client refetching; `refreshing` is the server
            rebuilding behind a stale answer. Both mean "these numbers are
            not final", so both say so. */}
        {stale || data.refreshing ? (
          <span className="dd-pulse text-xs text-kraken-shadow">refreshing</span>
        ) : (
          <button
            type="button"
            onClick={refresh}
            className="text-xs text-kraken-shadow transition hover:text-kraken-ice"
          >
            refresh
          </button>
        )}
      </div>

      {error ? (
        // A failed *refresh* keeps the cached payload on screen — the
        // numbers below are still real, just older than intended.
        <p className="mt-2 text-xs text-kraken-alert" role="alert">
          Refresh failed: {error}. Showing the last good read.
        </p>
      ) : null}

      {/* Top lines. Every tile is a live number; none of them is a zero that
          only means "nothing configured". */}
      <dl className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
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
        {/* There was a fifth tile here — "open", reading `11 / 8 PRs · 3
            issues`. It said exactly what the "All open work" row a few
            pixels below now says in its collapsed summary, so it was the
            same fact twice on one screen. Four is also the shape Analytics
            → Flow already uses for a headline row, and this page should
            not invent a second one. The count still has one home, and the
            unread-vs-zero distinction lives there. */}
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

      {/* All open work.
          This used to be a "Top TODOs" list rendered open, directly under
          "Start here" — and every linked item in "Start here" is drawn from
          the same ranking, so the top of the dashboard showed the same two
          PRs twice, ~120px apart. "Start here" is the answer; this is the
          evidence behind it, and evidence belongs one tap away. The summary
          carries the counts so you never open it just to find out whether
          it's worth opening. */}
      {todosUnavailable ? (
        <p className="mt-4 rounded-lg border border-kraken-boundless px-3 py-2 text-xs text-kraken-shadow">
          {github.reason ?? "GitHub is unavailable"} — open work could not be
          read. This is not the same as having nothing open.
        </p>
      ) : todos.length === 0 ? (
        <p className="mt-4 text-xs text-kraken-shadow">
          Nothing open. No PRs or issues assigned to you.
        </p>
      ) : (
        <div className="mt-4">
          <Disclosure
            title="All open work"
            summary={openWorkSummary(github, staleCount)}
          >
            <ul className="divide-y divide-kraken-boundless/60">
              {todos.map((todo, i) => (
                <TodoRow key={todo.key} todo={todo} index={i} />
              ))}
            </ul>
            {staleCount > 0 ? (
              // Demoted, not dropped — say how many so the tail is visible.
              <p className="mt-2 text-xs text-kraken-shadow">
                Plus {staleCount} open item{staleCount === 1 ? "" : "s"}{" "}
                untouched for over 6 months, ranked below everything current.
              </p>
            ) : null}
          </Disclosure>
        </div>
      )}

      {/* Shipped — the commit/PR history behind the top lines. Uses the
          house Disclosure so it matches Analytics → Flow, whose collapsed
          rows each carry their own headline. */}
      {shipped.recentMerged.length > 0 || shipped.byProject.length > 0 ? (
        <div className="mt-2">
        <Disclosure
          title="What shipped"
          summary={`${shipped.commits} commits · ${shipped.recentMerged.length} merged PRs`}
        >
          <div>
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
        </Disclosure>
        </div>
      ) : null}

      <RecentSessions recent={data.recent} />
      </section>
    </>
  );
}

/**
 * Cold-load placeholder.
 *
 * Shown only when there is genuinely nothing cached — with the client
 * cache in place that is a first-ever visit or a new browser session, not
 * an ordinary navigation. It mirrors the real layout so the page doesn't
 * jump when data lands.
 */
function OpenerSkeleton() {
  return (
    <div className="mb-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading this week’s activity</span>
      <div className="dd-skeleton h-7 w-40 rounded-md" />
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => (
          <div
            key={i}
            className="dd-skeleton h-[68px] rounded-lg border border-kraken-boundless"
          />
        ))}
      </div>
      <div className="dd-skeleton mt-6 h-5 w-28 rounded-md" />
      <div className="dd-skeleton mt-2 h-[132px] rounded-lg border border-kraken-boundless" />
    </div>
  );
}

/**
 * The headline a collapsed "All open work" row must carry.
 *
 * An unread count renders as an em dash here for the same reason it does
 * in the tiles: a search that failed and a search that returned nothing
 * must not produce the same string.
 */
function openWorkSummary(
  github: Overview["github"],
  staleCount: number,
): string {
  const part = (value: number | null, truncated: boolean, noun: string) =>
    value === null ? `— ${noun}` : `${countLabel(value, truncated)} ${noun}`;
  const head = `${part(github.openPulls, github.openPullsTruncated, "PRs")} · ${part(
    github.openIssues,
    github.openIssuesTruncated,
    "issues",
  )}`;
  return staleCount > 0 ? `${head} · +${staleCount} stale` : head;
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

function TodoRow({ todo, index }: { todo: OverviewTodo; index: number }) {
  return (
    <li
      className="dd-rise"
      // Capped so a long list's tail doesn't arrive noticeably late.
      style={{ ["--dd-delay" as string]: `${Math.min(index, 6) * 35}ms` }}
    >
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
