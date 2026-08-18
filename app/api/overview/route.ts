import { NextResponse } from "next/server";
import { getGithubWork } from "@/lib/connectors/github-work";
import { fetchWeeklyPullActivity } from "@/lib/connectors/github-weekly";
import { commitSummaryFor } from "@/lib/projects/commit-stats";
import { listProjects } from "@/lib/db/projects";
import { readClaudeUsage } from "@/lib/providers/claude-usage";
import { buildOverview, type Overview } from "@/lib/insights/overview";
import { readRecentSessions } from "@/lib/connectors/recent-sessions";
import {
  SESSION_TOOLS,
  type RecentSessionsResult,
} from "@/lib/connectors/recent-sessions.types";
import { buildNextUp, type NextUp } from "@/lib/insights/next-up";

export const runtime = "nodejs";

/**
 * GET /api/overview — the dashboard opener: this week's session stats plus a
 * short ranked list of open PRs and issues.
 *
 * Stale-while-revalidate, for the same reason `/api/provider-budgets` is:
 * both of its inputs are slow. `readClaudeUsage()` streams a few hundred
 * session logs, and `getGithubWork()` is two network round-trips through
 * `gh`. Blocking the first paint of the app's landing page on either is how
 * you get a dashboard nobody opens.
 *
 * So: serve whatever we have immediately, refresh behind it, and tell the
 * client which of those two happened via `cachedAt` / `refreshing`. Only a
 * genuinely cold process blocks, because then there is nothing to show.
 */

const CACHE_TTL_MS = 60 * 1000;

interface OverviewResponse extends Overview {
  cachedAt: string;
  refreshing?: boolean;
  /** Recent working sessions across Claude Code, Codex and Antigravity. */
  recent: RecentSessionsResult;
  /** The ranked "start here" list at the top of the dashboard. */
  nextUp: NextUp;
}

let cache: { at: number; data: OverviewResponse } | null = null;
let inFlight: Promise<OverviewResponse> | null = null;

/** The window every "this week" figure on the opener shares. */
const WEEK_DAYS = 7;

async function readAll(): Promise<OverviewResponse> {
  const projects = listProjects();
  const since = new Date(Date.now() - WEEK_DAYS * 86_400_000);

  // Five independent reads, run together, each failing on its own terms. A
  // usage read that throws must not blank the TODO list, and a `gh` outage
  // must not hide your commits — the two GitHub connectors already model
  // their own unavailability rather than throwing.
  const [work, usage, commits, pulls, recent] = await Promise.all([
    getGithubWork(false),
    readClaudeUsage().catch(() => null),
    commitSummaryFor(
      projects.map((p) => p.path),
      WEEK_DAYS,
    ),
    fetchWeeklyPullActivity(since),
    // The session read is bounded (mtime pre-filter + head/tail slices,
    // ~250ms against 888 MB of logs), so it rides along here rather than
    // costing the client a second request. A failure degrades to "no
    // sessions read" with every tool marked unhealthy, never to a throw
    // that would take the whole opener down with it.
    readRecentSessions().catch(
      (err: Error): RecentSessionsResult => ({
        sessions: [],
        // From the shared list, not a second copy of it — a fourth tool
        // would otherwise be reported as healthy-but-absent on this path
        // while every other path knew about it.
        tools: SESSION_TOOLS.map((tool) => ({
          tool,
          health: "error" as const,
          lastActiveAt: null,
          filesRead: 0,
          skipped: 0,
          reason: err.message,
        })),
        windowDays: 0,
      }),
    ),
  ]);

  const overview = buildOverview({
    work,
    usage,
    commits,
    pulls,
    projectNames: new Map(projects.map((p) => [p.path, p.name])),
  });

  return {
    ...overview,
    recent,
    nextUp: buildNextUp({
      sessions: recent.sessions,
      todos: overview.todos,
      // Per-category, not per-source (Codex, PR #41). `todosUnavailable` is
      // only true when *both* GitHub searches failed, so a run where the
      // issue search errored and the PR search succeeded would have set
      // `partial: false` and presented a ranking missing every issue as if
      // it were the complete picture. That is DD-027's exact shape — one
      // `status` standing in for N independent reads — reappearing in a new
      // consumer. A count that came back `null` was never read.
      todosAvailable:
        overview.github.openPulls !== null && overview.github.openIssues !== null,
      todosReason: overview.github.reason,
    }),
    cachedAt: new Date().toISOString(),
  };
}

function refresh(): Promise<OverviewResponse> {
  if (inFlight) return inFlight;
  inFlight = readAll()
    .then((data) => {
      cache = { at: Date.now(), data };
      return data;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export async function GET() {
  const now = Date.now();

  if (cache) {
    const stale = now - cache.at >= CACHE_TTL_MS;
    if (stale) void refresh().catch(() => {});
    return NextResponse.json({
      ...cache.data,
      refreshing: stale || inFlight !== null,
    });
  }

  const data = await refresh();
  return NextResponse.json({ ...data, refreshing: false });
}
