import { scanFlow, type FlowCommit } from "../connectors/git-flow";
import { getGithubWork, type GithubWork } from "../connectors/github-work";
import { dayKeyOffset, dayKeyRange, localDayKey, parseDayKey } from "../util/day";
import {
  summarizeAttribution,
  type AttributionSummary,
} from "./attribution";

/**
 * The Flow tab's payload (EP-11 Spec C).
 *
 * ── Solo-dev metric doctrine (binding, from the plan) ───────────────────
 * No DORA cargo-culting. Change-failure-rate and MTTR are explicitly out:
 * they're team-coordination metrics, and computing them for one person
 * would produce numbers that look rigorous and mean nothing. What ships
 * here is what a solo developer can actually act on — cadence, streak,
 * when you work, which projects are hot, and how much of the shipped
 * work carried an agent's name.
 *
 * Every AI-share figure is accompanied by its **trailer coverage**,
 * because a branch-name inference is not a measurement.
 */

export interface FlowDay {
  day: string;
  commits: number;
  additions: number;
  deletions: number;
}

export interface FlowRepo {
  repo: string;
  commits: number;
  additions: number;
  deletions: number;
  aiShare: number;
  lastCommitDay: string | null;
}

export interface FlowSummary {
  windowDays: number;
  fromDay: string;
  toDay: string;
  totalCommits: number;
  totalAdditions: number;
  totalDeletions: number;
  /** Dense — every day in the window, zeros included. */
  daily: FlowDay[];
  /** (weekday, hour) → commit count. Same shape as the usage rhythm. */
  punchcard: Array<{ weekday: number; hour: number; commits: number }>;
  /** Consecutive days with at least one commit, ending today or yesterday. */
  currentStreak: number;
  longestStreak: number;
  attribution: AttributionSummary;
  repos: FlowRepo[];
  reposRead: number;
  root: string;
  /** Open PRs/issues, so "what's in flight" sits with "what shipped". */
  github: GithubWork | null;
  reason: string | null;
  generatedAt: string;
  /**
   * True when this payload was served stale while a rebuild runs behind it
   * (Codex, PR #41).
   *
   * Without it the server half of stale-while-revalidate is the only half
   * that exists: the client is handed old numbers with no way to tell, so
   * it clears its own "refreshing" marker and never comes back for the
   * rebuilt result. The figures then sit stale for as long as the tab
   * stays mounted. Pair with `generatedAt` to say how old they are.
   */
  refreshing?: boolean;
}

export interface FlowSummaryOptions {
  windowDays?: number;
  now?: Date;
  includeGithub?: boolean;
}

/**
 * In-process cache, stale-while-revalidate.
 *
 * ── Why not a plain TTL ─────────────────────────────────────────────────
 * This sweep was measured at **16–25s across 34 repos** (2026-08-13, M-
 * series Mac, warm page cache) — not the "~7s" an earlier revision of this
 * comment claimed. That gap mattered: under a plain 5-minute TTL, exactly
 * one request per five minutes paid the whole 25s, and since the Analytics
 * tab is the thing that requests it, the tab was reliably broken rather
 * than occasionally slow.
 *
 * Stale-while-revalidate converts that cost into staleness instead: an
 * expired entry is returned *immediately* and a rebuild starts behind it,
 * de-duped so a burst of requests triggers one sweep. Only a genuinely
 * cold process blocks, because then there is nothing to show.
 *
 * The response carries `generatedAt`, so a caller can always say how old
 * the numbers are rather than implying they are live.
 */
let cache: { key: string; at: number; value: FlowSummary } | null = null;
let inFlight: { key: string; promise: Promise<FlowSummary> } | null = null;
export const FLOW_TTL_MS = 5 * 60 * 1000;

function refreshFlow(
  cacheKey: string,
  options: FlowSummaryOptions,
): Promise<FlowSummary> {
  if (inFlight && inFlight.key === cacheKey) return inFlight.promise;
  const promise = computeFlowSummary(options)
    .then((value) => {
      cache = { key: cacheKey, at: Date.now(), value };
      return value;
    })
    .finally(() => {
      if (inFlight?.key === cacheKey) inFlight = null;
    });
  inFlight = { key: cacheKey, promise };
  return promise;
}

export async function buildFlowSummary(
  options: FlowSummaryOptions = {},
): Promise<FlowSummary> {
  // A test passing an explicit `now` must neither read nor poison the
  // production cache.
  if (options.now) return computeFlowSummary(options);

  const cacheKey = `${options.windowDays ?? 90}|${options.includeGithub ? 1 : 0}`;
  if (cache && cache.key === cacheKey) {
    if (Date.now() - cache.at >= FLOW_TTL_MS) {
      // Rebuild behind the answer. Errors are swallowed here on purpose:
      // this promise has no caller, and an unhandled rejection would take
      // the process down over a background refresh whose stale result is
      // still on screen. The next foreground call surfaces the failure.
      void refreshFlow(cacheKey, options).catch(() => {});
    }
    // Report whether a rebuild is actually running right now — including
    // one started by an earlier request that hasn't landed yet, which is
    // why this checks `inFlight` rather than just the staleness test above.
    const refreshing = inFlight?.key === cacheKey;
    return refreshing ? { ...cache.value, refreshing } : cache.value;
  }
  // A cold build is awaited, so what it returns is fresh by definition.
  return refreshFlow(cacheKey, options);
}

export function _resetFlowCacheForTests(): void {
  cache = null;
  inFlight = null;
}

async function computeFlowSummary(
  options: FlowSummaryOptions,
): Promise<FlowSummary> {
  const now = options.now ?? new Date();
  const windowDays = clamp(options.windowDays ?? 90, 1, 730);
  const toDay = localDayKey(now);
  const fromDay = dayKeyOffset(now, windowDays - 1);

  const scan = await scanFlow(windowDays);
  // Commits outside the window can slip in: `git log --since` is
  // approximate at the boundary and author dates can precede commit
  // dates. Filter to the window we're actually reporting on.
  const commits = scan.commits.filter(
    (c) => c.day >= fromDay && c.day <= toDay,
  );

  const github = options.includeGithub
    ? await getGithubWork().catch(() => null)
    : null;

  return {
    windowDays,
    fromDay,
    toDay,
    totalCommits: commits.length,
    totalAdditions: sum(commits, (c) => c.additions),
    totalDeletions: sum(commits, (c) => c.deletions),
    daily: densedaily(commits, fromDay, toDay),
    punchcard: punchcard(commits),
    ...streaks(commits, now),
    attribution: summarizeAttribution(
      commits.map((c) => ({
        agent: c.agent,
        model: c.model,
        source: c.source,
        additions: c.additions,
        deletions: c.deletions,
      })),
    ),
    repos: repoBreakdown(commits),
    reposRead: scan.reposRead,
    root: scan.root,
    github,
    reason: scan.reason,
    generatedAt: now.toISOString(),
  };
}

function sum(commits: FlowCommit[], pick: (c: FlowCommit) => number): number {
  return commits.reduce((acc, c) => acc + pick(c), 0);
}

function densedaily(
  commits: FlowCommit[],
  fromDay: string,
  toDay: string,
): FlowDay[] {
  const byDay = new Map<string, FlowDay>();
  for (const commit of commits) {
    const entry = byDay.get(commit.day) ?? {
      day: commit.day,
      commits: 0,
      additions: 0,
      deletions: 0,
    };
    entry.commits += 1;
    entry.additions += commit.additions;
    entry.deletions += commit.deletions;
    byDay.set(commit.day, entry);
  }
  // Dense: a day with no commits is an explicit zero, so a gap in the
  // heatmap reads as "nothing shipped" rather than "chart ends here".
  return dayKeyRange(fromDay, toDay).map(
    (day) =>
      byDay.get(day) ?? { day, commits: 0, additions: 0, deletions: 0 },
  );
}

function punchcard(
  commits: FlowCommit[],
): Array<{ weekday: number; hour: number; commits: number }> {
  const cells = new Map<string, { weekday: number; hour: number; commits: number }>();
  for (const commit of commits) {
    const date = parseDayKey(commit.day);
    if (!date) continue;
    const weekday = date.getDay();
    const key = `${weekday}-${commit.hour}`;
    const cell = cells.get(key) ?? { weekday, hour: commit.hour, commits: 0 };
    cell.commits += 1;
    cells.set(key, cell);
  }
  return [...cells.values()];
}

/**
 * Streaks over *calendar days with at least one commit*.
 *
 * The current streak is allowed to end yesterday rather than today —
 * otherwise it would read as broken every morning until the first commit,
 * which is both discouraging and wrong.
 */
function streaks(
  commits: FlowCommit[],
  now: Date,
): { currentStreak: number; longestStreak: number } {
  const days = new Set(commits.map((c) => c.day));
  if (days.size === 0) return { currentStreak: 0, longestStreak: 0 };

  const sorted = [...days].sort();
  let longest = 1;
  let run = 1;
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = parseDayKey(sorted[i - 1]);
    const cur = parseDayKey(sorted[i]);
    if (!prev || !cur) continue;
    const gapDays = Math.round(
      (cur.getTime() - prev.getTime()) / 86_400_000,
    );
    run = gapDays === 1 ? run + 1 : 1;
    if (run > longest) longest = run;
  }

  let current = 0;
  const today = localDayKey(now);
  const yesterday = dayKeyOffset(now, 1);
  let cursor = days.has(today) ? today : days.has(yesterday) ? yesterday : null;
  while (cursor && days.has(cursor)) {
    current += 1;
    const date = parseDayKey(cursor);
    if (!date) break;
    cursor = dayKeyOffset(date, 1);
  }

  return { currentStreak: current, longestStreak: longest };
}

function repoBreakdown(commits: FlowCommit[]): FlowRepo[] {
  const byRepo = new Map<string, FlowRepo & { agentCommits: number }>();
  for (const commit of commits) {
    const entry = byRepo.get(commit.repo) ?? {
      repo: commit.repo,
      commits: 0,
      additions: 0,
      deletions: 0,
      aiShare: 0,
      lastCommitDay: null,
      agentCommits: 0,
    };
    entry.commits += 1;
    entry.additions += commit.additions;
    entry.deletions += commit.deletions;
    if (commit.agent !== "human") entry.agentCommits += 1;
    if (entry.lastCommitDay === null || commit.day > entry.lastCommitDay) {
      entry.lastCommitDay = commit.day;
    }
    byRepo.set(commit.repo, entry);
  }
  return [...byRepo.values()]
    .map(({ agentCommits, ...repo }) => ({
      ...repo,
      aiShare: repo.commits === 0 ? 0 : agentCommits / repo.commits,
    }))
    .sort((a, b) => b.commits - a.commits);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
