import { ghAuthStatus, runGhJson } from "@/lib/integrations/gh";

/**
 * Your pull-request activity over a recent window — what you opened, and
 * what actually landed.
 *
 * Separate from github-work.ts, which answers "what is open right now".
 * This answers "what did I do this week", which needs different queries
 * (`--created` / `--merged-at` rather than `--state open`) and is wanted in
 * a different place (the dashboard opener, not the backlog screen).
 */

const SEARCH_LIMIT = 60;

export interface WeeklyPull {
  number: number;
  repository: string;
  title: string;
  url: string;
  at: string;
}

export interface WeeklyPullActivity {
  status: "ok" | "unavailable";
  reason: string | null;
  merged: WeeklyPull[];
  opened: WeeklyPull[];
  /**
   * Per-query availability. `status` is "ok" when either half succeeded, so a
   * consumer reading only `status` renders `0 PRs merged` for a count that was
   * never read. Check these before presenting either length.
   */
  mergedOk: boolean;
  openedOk: boolean;
  /** Came back at SEARCH_LIMIT — a floor, not a total. */
  mergedTruncated: boolean;
  openedTruncated: boolean;
  /** Distinct repositories touched by either list. */
  repositories: string[];
  fetchedAt: string;
}

interface RawPull {
  number?: number;
  title?: string;
  url?: string;
  createdAt?: string;
  closedAt?: string;
  repository?: { nameWithOwner?: string };
}

function toWeekly(raw: RawPull, stampKey: "createdAt" | "closedAt"): WeeklyPull | null {
  const repository = raw.repository?.nameWithOwner;
  if (!repository || typeof raw.number !== "number") return null;
  return {
    number: raw.number,
    repository,
    title: raw.title ?? "(untitled)",
    url: raw.url ?? `https://github.com/${repository}/pull/${raw.number}`,
    at: raw[stampKey] ?? "",
  };
}

function unavailable(reason: string): WeeklyPullActivity {
  return {
    status: "unavailable",
    reason,
    merged: [],
    opened: [],
    mergedOk: false,
    openedOk: false,
    mergedTruncated: false,
    openedTruncated: false,
    repositories: [],
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * `YYYY-MM-DD` — the only date form `gh search` qualifiers accept.
 *
 * Note the resulting window is slightly wider than the caller's: truncating
 * to a UTC date floors to midnight, so a 7-day cutoff admits up to ~24h more.
 * That makes the PR counts a *marginally* longer window than the commit count
 * beside them, which comes from git's exact `--since=7 days ago`. Left as-is
 * because `gh search` has no finer qualifier, but it means the two figures on
 * the opener are not over byte-identical windows — worth knowing before
 * anyone tries to reconcile "54 PRs merged" against "57 commits" exactly.
 */
export function ghDateFloor(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * PRs you opened and merged since `since`.
 *
 * Never throws on a `gh` problem: an unauthenticated or missing CLI returns
 * `status: "unavailable"` with a reason, because zero merged PRs and a broken
 * integration must not render identically — one is a quiet week, the other
 * is a lie.
 */
export async function fetchWeeklyPullActivity(
  since: Date,
): Promise<WeeklyPullActivity> {
  const auth = await ghAuthStatus();
  if (!auth.authenticated) {
    return unavailable(auth.reason ?? "`gh` is not authenticated");
  }

  const floor = ghDateFloor(since);
  const [merged, opened] = await Promise.all([
    runGhJson<RawPull[]>([
      "search",
      "prs",
      "--author",
      "@me",
      "--merged",
      "--merged-at",
      `>=${floor}`,
      "--limit",
      String(SEARCH_LIMIT),
      "--json",
      "number,title,url,repository,closedAt",
    ]),
    runGhJson<RawPull[]>([
      "search",
      "prs",
      "--author",
      "@me",
      "--created",
      `>=${floor}`,
      "--limit",
      String(SEARCH_LIMIT),
      "--json",
      "number,title,url,repository,createdAt",
    ]),
  ]);

  if (!merged.ok && !opened.ok) {
    return unavailable(merged.reason ?? opened.reason ?? "gh query failed");
  }

  const mergedList = (merged.data ?? [])
    .map((r) => toWeekly(r, "closedAt"))
    .filter((p): p is WeeklyPull => p !== null)
    .sort((a, b) => (a.at < b.at ? 1 : -1));
  const openedList = (opened.data ?? [])
    .map((r) => toWeekly(r, "createdAt"))
    .filter((p): p is WeeklyPull => p !== null)
    .sort((a, b) => (a.at < b.at ? 1 : -1));

  return {
    status: "ok",
    // Partial failure is reported, not hidden — the surviving half still
    // renders, with a line saying which half is missing.
    reason: !merged.ok
      ? `merged PRs unavailable — ${merged.reason}`
      : !opened.ok
        ? `opened PRs unavailable — ${opened.reason}`
        : null,
    merged: mergedList,
    opened: openedList,
    mergedOk: merged.ok,
    openedOk: opened.ok,
    mergedTruncated: (merged.data ?? []).length >= SEARCH_LIMIT,
    openedTruncated: (opened.data ?? []).length >= SEARCH_LIMIT,
    repositories: [
      ...new Set([...mergedList, ...openedList].map((p) => p.repository)),
    ].sort(),
    fetchedAt: new Date().toISOString(),
  };
}
