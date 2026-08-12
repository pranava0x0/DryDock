import { NextResponse } from "next/server";
import { getGithubWork } from "@/lib/connectors/github-work";
import { fetchWeeklyPullActivity } from "@/lib/connectors/github-weekly";
import { commitSummaryFor } from "@/lib/projects/commit-stats";
import { listProjects } from "@/lib/db/projects";
import { readClaudeUsage } from "@/lib/providers/claude-usage";
import { buildOverview, type Overview } from "@/lib/insights/overview";

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
}

let cache: { at: number; data: OverviewResponse } | null = null;
let inFlight: Promise<OverviewResponse> | null = null;

/** The window every "this week" figure on the opener shares. */
const WEEK_DAYS = 7;

async function readAll(): Promise<OverviewResponse> {
  const projects = listProjects();
  const since = new Date(Date.now() - WEEK_DAYS * 86_400_000);

  // Four independent reads, run together, each failing on its own terms. A
  // usage read that throws must not blank the TODO list, and a `gh` outage
  // must not hide your commits — the two GitHub connectors already model
  // their own unavailability rather than throwing.
  const [work, usage, commits, pulls] = await Promise.all([
    getGithubWork(false),
    readClaudeUsage().catch(() => null),
    commitSummaryFor(
      projects.map((p) => p.path),
      WEEK_DAYS,
    ),
    fetchWeeklyPullActivity(since),
  ]);

  return {
    ...buildOverview({
      work,
      usage,
      commits,
      pulls,
      projectNames: new Map(projects.map((p) => [p.path, p.name])),
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
