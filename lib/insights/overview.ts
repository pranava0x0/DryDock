import type { GithubWork } from "@/lib/connectors/github-work";
import type { WeeklyPullActivity } from "@/lib/connectors/github-weekly";
import type { CommitSummary } from "@/lib/projects/commit-stats";
import type { ClaudeUsageReport } from "@/lib/providers/claude-usage";

/**
 * The opener's payload: a few headline lines and a short ranked TODO list.
 *
 * The dashboard used to open on 30 project cards showing `0 pending / 0
 * active / 0 done` — thirty rows of zeros, which is a wall of data that
 * answers no question. This module builds the two things worth seeing
 * first: what happened this week, and what is waiting on you.
 */

export interface OverviewTodo {
  kind: "pr" | "issue";
  /** Stable across refreshes — `owner/repo#123`. */
  key: string;
  title: string;
  url: string;
  repository: string;
  number: number;
  /** Short status word for the UI. */
  label: string;
  updatedAt: string;
  /** Whole days since last update, or null when the timestamp was unusable. */
  ageDays: number | null;
}

export interface OverviewWeek {
  sessions: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

/** What you actually shipped this week, from git and from GitHub. */
export interface OverviewShipped {
  commits: number;
  /** Repos with at least one commit in the window. */
  activeRepos: number;
  /** Repos that couldn't be read — surfaced so `commits` is never mistaken
   *  for a complete count when some paths failed. */
  unreadableRepos: number;
  /** Busiest repos first, with recent subjects for a sense of what happened. */
  byProject: Array<{ path: string; name: string; count: number; subjects: string[] }>;
  pullsMerged: number;
  pullsOpened: number;
  /** Newest-first, capped for the opener. */
  recentMerged: Array<{ title: string; repository: string; number: number; url: string; at: string }>;
  /** Null when `gh` couldn't answer — distinct from "you merged nothing". */
  pullsUnavailable: boolean;
  pullsReason: string | null;
}

export interface Overview {
  week: OverviewWeek | null;
  shipped: OverviewShipped;
  github: {
    status: GithubWork["status"];
    reason: string | null;
    login: string | null;
    openPulls: number;
    openIssues: number;
    fetchedAt: string | null;
  };
  todos: OverviewTodo[];
  /** Open items older than STALE_DAYS, demoted below everything fresh. Shown
   *  as a count so a long tail of ancient work is visible without occupying
   *  the list. */
  staleCount: number;
  /** True when `todos` is empty *because* gh couldn't answer, not because
   *  there's nothing open. An empty list and a broken integration must not
   *  look the same. */
  todosUnavailable: boolean;
  generatedAt: string;
}

function ageDaysFrom(iso: string, now: Date): number | null {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  return Math.max(0, Math.floor((now.getTime() - then) / 86_400_000));
}

/**
 * Past this age an open item is treated as archaeology, not a TODO.
 *
 * Six months. Chosen from the real data: this account has open PRs from 2014
 * university coursework, 4,300 days stale. Ranked purely by recency they
 * filled most of a six-row list and pushed this week's work off the bottom —
 * the exact failure github-work.ts warns about, "the difference between a
 * useful list and one the user learns to ignore".
 */
export const STALE_DAYS = 180;

export interface RankedTodos {
  todos: OverviewTodo[];
  /** Open items older than STALE_DAYS, whether or not they made the list. */
  staleCount: number;
}

/**
 * Rank open work into a short "what's waiting on you" list.
 *
 * ## What we can and cannot rank on
 *
 * `gh search prs` returns no review decision, no mergeability and no check
 * status — github-work.ts sets all three to null on purpose rather than
 * spend one API call per PR. So this cannot say "checks failing" or
 * "changes requested", and it doesn't pretend to. The signals that really
 * exist are: PR vs issue, draft vs not, and last-updated.
 *
 * Tiers, most actionable first:
 *   0. open non-draft PR — work already written, waiting on a merge
 *   1. open issue — real work, not yet started
 *   2. draft PR — in flight by your own declaration, so least surprising
 *   3. anything older than STALE_DAYS, regardless of kind
 *
 * Within a tier, most recently touched first. Stale items are demoted rather
 * than filtered out, and `staleCount` is reported separately so the UI can
 * say how many exist — a hidden cutoff that silently drops real work is the
 * thing to avoid, but so is an opener made of 2014.
 */
export function rankTodos(
  work: GithubWork,
  limit = 6,
  now: Date = new Date(),
): RankedTodos {
  const todos: Array<OverviewTodo & { tier: number }> = [];

  const isStale = (iso: string): boolean => {
    const age = ageDaysFrom(iso, now);
    return age !== null && age > STALE_DAYS;
  };

  for (const pull of work.pulls) {
    todos.push({
      tier: isStale(pull.updatedAt) ? 3 : pull.isDraft ? 2 : 0,
      kind: "pr",
      key: `${pull.repository}#${pull.number}`,
      title: pull.title,
      url: pull.url,
      repository: pull.repository,
      number: pull.number,
      label: pull.isDraft ? "draft PR" : "PR open",
      updatedAt: pull.updatedAt,
      ageDays: ageDaysFrom(pull.updatedAt, now),
    });
  }

  for (const issue of work.issues) {
    todos.push({
      tier: isStale(issue.updatedAt) ? 3 : 1,
      kind: "issue",
      key: `${issue.repository}#${issue.number}`,
      title: issue.title,
      url: issue.url,
      repository: issue.repository,
      number: issue.number,
      label: "issue",
      updatedAt: issue.updatedAt,
      ageDays: ageDaysFrom(issue.updatedAt, now),
    });
  }

  todos.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    const at = Date.parse(a.updatedAt);
    const bt = Date.parse(b.updatedAt);
    // Unparseable timestamps sort last rather than to 1970.
    if (!Number.isFinite(at) && !Number.isFinite(bt)) return 0;
    if (!Number.isFinite(at)) return 1;
    if (!Number.isFinite(bt)) return -1;
    return bt - at;
  });

  // Stale items are excluded from the list rather than merely sorted below
  // it. With only three current items and a six-row list, demotion alone
  // still padded the opener with 2014 coursework — technically ranked last,
  // and still the first thing on screen. The count keeps them visible.
  return {
    todos: todos
      .filter((t) => t.tier !== 3)
      .slice(0, limit)
      .map(({ tier: _tier, ...todo }) => todo),
    staleCount: todos.filter((t) => t.tier === 3).length,
  };
}

/** How many merged PRs the opener lists before it stops. */
const RECENT_MERGED_LIMIT = 5;

export interface OverviewInputs {
  work: GithubWork;
  usage: ClaudeUsageReport | null;
  commits: CommitSummary;
  pulls: WeeklyPullActivity;
  /** Maps a project path back to its display name for the commit breakdown. */
  projectNames?: Map<string, string>;
}

/** Compose the opener from its reads. None of them may throw. */
export function buildOverview(
  { work, usage, commits, pulls, projectNames }: OverviewInputs,
  limit = 6,
  now: Date = new Date(),
): Overview {
  const unavailable = work.status !== "ok";
  const pullsUnavailable = pulls.status !== "ok";

  return {
    week: usage
      ? {
          sessions: usage.weekly.sessions,
          turns: usage.weekly.assistantTurns,
          inputTokens: usage.weekly.inputTokens,
          outputTokens: usage.weekly.outputTokens,
          cacheReadTokens: usage.weekly.cacheReadInputTokens,
        }
      : null,
    shipped: {
      commits: commits.totalCommits,
      activeRepos: commits.activeRepos,
      unreadableRepos: commits.unavailableRepos,
      byProject: commits.byProject.map((p) => ({
        ...p,
        // Fall back to the trailing path segment — better than a bare path in
        // a summary line, and never blank.
        name: projectNames?.get(p.path) ?? p.path.split("/").pop() ?? p.path,
      })),
      pullsMerged: pulls.merged.length,
      pullsOpened: pulls.opened.length,
      recentMerged: pulls.merged.slice(0, RECENT_MERGED_LIMIT).map((p) => ({
        title: p.title,
        repository: p.repository,
        number: p.number,
        url: p.url,
        at: p.at,
      })),
      pullsUnavailable,
      pullsReason: pulls.reason,
    },
    github: {
      status: work.status,
      reason: work.reason,
      login: work.login,
      openPulls: work.pulls.length,
      openIssues: work.issues.length,
      fetchedAt: work.fetchedAt ?? null,
    },
    ...(() => {
      const ranked = unavailable
        ? { todos: [], staleCount: 0 }
        : rankTodos(work, limit, now);
      return { todos: ranked.todos, staleCount: ranked.staleCount };
    })(),
    todosUnavailable: unavailable,
    generatedAt: now.toISOString(),
  };
}
