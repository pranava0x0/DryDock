import { ghAuthStatus, runGhJson } from "../integrations/gh";

/**
 * Open work on GitHub — pull requests and issues — surfaced beside the
 * backlog.
 *
 * ── Why PRs are shown but never imported as backlog items ───────────────
 * An open PR is not an idea waiting to be decided on; it's work already
 * underway that is *blocking on you*. Importing one as a backlog row
 * would put it in a list whose actions ("burn down", "mark done") are all
 * wrong for it, and would double-count it against the ideas you actually
 * have to triage. So PRs render as their own read-only section: they're
 * outstanding, they belong on the same screen, and clicking one takes you
 * to GitHub where the actual action lives.
 *
 * **Issues are different** and do flow into the backlog — an issue is a
 * unit of intended work, which is exactly what a backlog item is (EP-13
 * makes that mirror bidirectional).
 *
 * Everything here is read-only and degrades to an explicit
 * "gh unavailable" state rather than an empty list, because an empty list
 * reads as "you have nothing open", which is a very different and much
 * more relaxing message than the truth.
 */

export interface GithubPull {
  id: string;
  number: number;
  repository: string;
  title: string;
  url: string;
  isDraft: boolean;
  updatedAt: string;
  /** Mergeable / conflicted / unknown, straight from GitHub. */
  mergeable: string | null;
  /** Rolled-up CI state when GitHub reports one. */
  checks: string | null;
  reviewDecision: string | null;
}

export interface GithubIssue {
  id: string;
  number: number;
  repository: string;
  title: string;
  url: string;
  updatedAt: string;
  labels: string[];
}

export interface GithubWork {
  status: "ok" | "unavailable";
  reason: string | null;
  login: string | null;
  pulls: GithubPull[];
  issues: GithubIssue[];
  fetchedAt: string;
}

/** Enough to see what's outstanding; more would be a different screen. */
const SEARCH_LIMIT = 30;

function unavailable(reason: string): GithubWork {
  return {
    status: "unavailable",
    reason,
    login: null,
    pulls: [],
    issues: [],
    fetchedAt: new Date().toISOString(),
  };
}

interface RawPull {
  id?: string;
  number?: number;
  title?: string;
  url?: string;
  isDraft?: boolean;
  updatedAt?: string;
  repository?: { nameWithOwner?: string };
  state?: string;
}

interface RawIssue {
  id?: string;
  number?: number;
  title?: string;
  url?: string;
  updatedAt?: string;
  repository?: { nameWithOwner?: string };
  labels?: Array<{ name?: string }>;
}

/**
 * Every open PR the user authored, across all repos they can see —
 * private included, since `gh` carries their own `repo` scope.
 *
 * `gh search prs` rather than a per-repo loop: one API call instead of 34,
 * and it costs a single point against a 5,000/hour budget.
 */
export async function fetchGithubWork(): Promise<GithubWork> {
  const auth = await ghAuthStatus();
  if (!auth.authenticated) {
    return unavailable(auth.reason ?? "`gh` is not authenticated");
  }

  const [pulls, issues] = await Promise.all([
    runGhJson<RawPull[]>([
      "search",
      "prs",
      "--author",
      "@me",
      "--state",
      "open",
      "--limit",
      String(SEARCH_LIMIT),
      "--json",
      "id,number,title,url,isDraft,updatedAt,repository",
    ]),
    runGhJson<RawIssue[]>([
      "search",
      "issues",
      "--author",
      "@me",
      "--state",
      "open",
      "--limit",
      String(SEARCH_LIMIT),
      "--json",
      "id,number,title,url,updatedAt,repository,labels",
    ]),
  ]);

  // One failing half must not blank the other. If BOTH fail it's a real
  // outage and we say so; if one does, report what we have.
  if (!pulls.ok && !issues.ok) {
    return unavailable(pulls.reason ?? issues.reason ?? "gh query failed");
  }

  return {
    status: "ok",
    reason: !pulls.ok
      ? `pull requests unavailable — ${pulls.reason}`
      : !issues.ok
        ? `issues unavailable — ${issues.reason}`
        : null,
    login: auth.login,
    // Newest first. `gh search` doesn't guarantee an order, and an
    // eleven-year-old university-project issue sitting above this
    // week's PR is the difference between a useful list and one the
    // user learns to ignore. Sorting rather than date-filtering is
    // deliberate: a hidden cutoff would silently drop real work, while
    // a stale item sorted to the bottom with its age visible is
    // something the user can judge for themselves.
    pulls: (pulls.data ?? [])
      .map(toPull)
      .filter((p): p is GithubPull => p !== null)
      .sort(byUpdatedDesc),
    issues: (issues.data ?? [])
      .map(toIssue)
      .filter((i): i is GithubIssue => i !== null)
      .sort(byUpdatedDesc),
    fetchedAt: new Date().toISOString(),
  };
}

function byUpdatedDesc(
  a: { updatedAt: string },
  b: { updatedAt: string },
): number {
  return (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);
}

function toPull(raw: RawPull): GithubPull | null {
  const repository = raw.repository?.nameWithOwner;
  if (!repository || typeof raw.number !== "number") return null;
  return {
    id: raw.id ?? `${repository}#${raw.number}`,
    number: raw.number,
    repository,
    title: raw.title ?? "(untitled)",
    url: raw.url ?? `https://github.com/${repository}/pull/${raw.number}`,
    isDraft: raw.isDraft === true,
    updatedAt: raw.updatedAt ?? "",
    // `gh search prs` doesn't return these; they'd need a per-PR query,
    // which isn't worth 30 extra API calls for a summary list. Null is
    // honest — the UI renders nothing rather than a guessed status.
    mergeable: null,
    checks: null,
    reviewDecision: null,
  };
}

function toIssue(raw: RawIssue): GithubIssue | null {
  const repository = raw.repository?.nameWithOwner;
  if (!repository || typeof raw.number !== "number") return null;
  return {
    id: raw.id ?? `${repository}#${raw.number}`,
    number: raw.number,
    repository,
    title: raw.title ?? "(untitled)",
    url: raw.url ?? `https://github.com/${repository}/issues/${raw.number}`,
    updatedAt: raw.updatedAt ?? "",
    labels: (raw.labels ?? [])
      .map((l) => l.name)
      .filter((n): n is string => typeof n === "string"),
  };
}

/** In-process cache — GitHub moves slowly and this runs on a page read. */
let cache: { at: number; value: GithubWork } | null = null;
export const GITHUB_WORK_TTL_MS = 5 * 60 * 1000;

export async function getGithubWork(force = false): Promise<GithubWork> {
  const now = Date.now();
  if (!force && cache && now - cache.at < GITHUB_WORK_TTL_MS) {
    return cache.value;
  }
  const value = await fetchGithubWork();
  // Don't cache a failure for five minutes: `gh auth login` in another
  // terminal should take effect on the next reload, not after a wait.
  if (value.status === "ok") cache = { at: now, value };
  return value;
}

export function _resetGithubWorkCacheForTests(): void {
  cache = null;
}
