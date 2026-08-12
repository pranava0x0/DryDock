import { describe, expect, it } from "vitest";
import { buildOverview, rankTodos } from "./overview";
import type { GithubWork, GithubPull, GithubIssue } from "@/lib/connectors/github-work";
import type { WeeklyPullActivity } from "@/lib/connectors/github-weekly";
import type { CommitSummary } from "@/lib/projects/commit-stats";

const NOW = new Date("2026-08-12T00:00:00.000Z");

function pull(over: Partial<GithubPull> = {}): GithubPull {
  return {
    id: "p1",
    number: 1,
    repository: "me/repo",
    title: "a pull",
    url: "https://github.com/me/repo/pull/1",
    isDraft: false,
    updatedAt: "2026-08-11T00:00:00.000Z",
    mergeable: null,
    checks: null,
    reviewDecision: null,
    ...over,
  };
}

function issue(over: Partial<GithubIssue> = {}): GithubIssue {
  return {
    id: "i1",
    number: 10,
    repository: "me/repo",
    title: "an issue",
    url: "https://github.com/me/repo/issues/10",
    updatedAt: "2026-08-11T00:00:00.000Z",
    labels: [],
    ...over,
  };
}

function work(over: Partial<GithubWork> = {}): GithubWork {
  return {
    status: "ok",
    reason: null,
    login: "me",
    pulls: [],
    issues: [],
    fetchedAt: NOW.toISOString(),
    ...over,
  };
}

const EMPTY_COMMITS: CommitSummary = {
  totalCommits: 0,
  activeRepos: 0,
  unavailableRepos: 0,
  byProject: [],
};

const EMPTY_PULLS: WeeklyPullActivity = {
  status: "ok",
  reason: null,
  merged: [],
  opened: [],
  repositories: [],
  fetchedAt: NOW.toISOString(),
};

describe("rankTodos", () => {
  it("puts open non-draft PRs above issues, and drafts last", () => {
    const { todos: ranked } = rankTodos(
      work({
        pulls: [
          pull({ number: 1, isDraft: true, title: "draft" }),
          pull({ number: 2, isDraft: false, title: "ready" }),
        ],
        issues: [issue({ number: 3, title: "issue" })],
      }),
      6,
      NOW,
    );
    expect(ranked.map((t) => t.title)).toEqual(["ready", "issue", "draft"]);
  });

  it("sorts most recently updated first within a tier", () => {
    const { todos: ranked } = rankTodos(
      work({
        pulls: [
          pull({ number: 1, title: "older", updatedAt: "2026-08-01T00:00:00.000Z" }),
          pull({ number: 2, title: "newer", updatedAt: "2026-08-11T00:00:00.000Z" }),
        ],
      }),
      6,
      NOW,
    );
    expect(ranked.map((t) => t.title)).toEqual(["newer", "older"]);
  });

  it("computes age in whole days and labels kind", () => {
    const { todos: [todo] } = rankTodos(
      work({ pulls: [pull({ updatedAt: "2026-08-09T00:00:00.000Z" })] }),
      6,
      NOW,
    );
    expect(todo.ageDays).toBe(3);
    expect(todo.kind).toBe("pr");
    expect(todo.label).toBe("PR open");
    expect(todo.key).toBe("me/repo#1");
  });

  it("sorts unparseable timestamps last instead of treating them as 1970", () => {
    const { todos: ranked } = rankTodos(
      work({
        pulls: [
          pull({ number: 1, title: "broken", updatedAt: "not-a-date" }),
          pull({ number: 2, title: "fine", updatedAt: "2026-08-01T00:00:00.000Z" }),
        ],
      }),
      6,
      NOW,
    );
    expect(ranked.map((t) => t.title)).toEqual(["fine", "broken"]);
    expect(ranked[1].ageDays).toBeNull();
  });

  /**
   * Regression for what the real data showed: this account has open PRs from
   * 2014 coursework. Ranked on recency alone they filled the list and pushed
   * the current week out entirely.
   */
  it("keeps items untouched for over 6 months out of the list, but counts them", () => {
    const { todos: ranked, staleCount } = rankTodos(
      work({
        pulls: [
          pull({ number: 1, title: "ancient", updatedAt: "2014-11-01T00:00:00.000Z" }),
          pull({ number: 2, title: "also ancient", updatedAt: "2016-03-01T00:00:00.000Z" }),
        ],
        issues: [issue({ number: 3, title: "this week" })],
      }),
      6,
      NOW,
    );
    // Room for all three, and it still shows only the current one — the list
    // is not padded to its limit with archaeology.
    expect(ranked.map((t) => t.title)).toEqual(["this week"]);
    expect(staleCount).toBe(2);
  });

  it("counts stale items even when they are cut by the limit", () => {
    const { todos: ranked, staleCount } = rankTodos(
      work({
        pulls: [
          pull({ number: 1, title: "fresh" }),
          pull({ number: 2, title: "old a", updatedAt: "2014-01-01T00:00:00.000Z" }),
          pull({ number: 3, title: "old b", updatedAt: "2014-01-02T00:00:00.000Z" }),
        ],
      }),
      1,
      NOW,
    );
    expect(ranked).toHaveLength(1);
    expect(ranked[0].title).toBe("fresh");
    // Not in the list, but not invisible either.
    expect(staleCount).toBe(2);
  });

  it("honours the limit", () => {
    const { todos: ranked } = rankTodos(
      work({ pulls: [pull({ number: 1 }), pull({ number: 2 }), pull({ number: 3 })] }),
      2,
      NOW,
    );
    expect(ranked).toHaveLength(2);
  });
});

describe("buildOverview", () => {
  /**
   * The distinction this pins down is the one that matters: a broken `gh`
   * and a genuinely empty queue must not produce the same payload, or the UI
   * renders "nothing open" over an outage.
   */
  it("flags an unavailable GitHub rather than reporting an empty queue", () => {
    const overview = buildOverview(
      {
        work: work({ status: "unavailable", reason: "gh not authenticated" }),
        usage: null,
        commits: EMPTY_COMMITS,
        pulls: EMPTY_PULLS,
      },
      6,
      NOW,
    );
    expect(overview.todos).toEqual([]);
    expect(overview.todosUnavailable).toBe(true);
    expect(overview.github.reason).toBe("gh not authenticated");
  });

  it("reports an empty queue as available and empty", () => {
    const overview = buildOverview(
      { work: work(), usage: null, commits: EMPTY_COMMITS, pulls: EMPTY_PULLS },
      6,
      NOW,
    );
    expect(overview.todos).toEqual([]);
    expect(overview.todosUnavailable).toBe(false);
  });

  it("carries commit totals and names each project", () => {
    const overview = buildOverview(
      {
        work: work(),
        usage: null,
        commits: {
          totalCommits: 14,
          activeRepos: 1,
          unavailableRepos: 2,
          byProject: [{ path: "/Users/me/Projects/DryDock", count: 14, subjects: ["fix a thing"] }],
        },
        pulls: EMPTY_PULLS,
        projectNames: new Map([["/Users/me/Projects/DryDock", "DryDock"]]),
      },
      6,
      NOW,
    );
    expect(overview.shipped.commits).toBe(14);
    expect(overview.shipped.unreadableRepos).toBe(2);
    expect(overview.shipped.byProject[0].name).toBe("DryDock");
  });

  it("falls back to the trailing path segment when a project has no name", () => {
    const overview = buildOverview(
      {
        work: work(),
        usage: null,
        commits: {
          ...EMPTY_COMMITS,
          byProject: [{ path: "/Users/me/Projects/Orphan", count: 1, subjects: [] }],
        },
        pulls: EMPTY_PULLS,
      },
      6,
      NOW,
    );
    expect(overview.shipped.byProject[0].name).toBe("Orphan");
  });

  it("distinguishes unavailable weekly PRs from zero merged", () => {
    const broken = buildOverview(
      {
        work: work(),
        usage: null,
        commits: EMPTY_COMMITS,
        pulls: { ...EMPTY_PULLS, status: "unavailable", reason: "gh missing" },
      },
      6,
      NOW,
    );
    expect(broken.shipped.pullsUnavailable).toBe(true);
    expect(broken.shipped.pullsMerged).toBe(0);

    const quiet = buildOverview(
      { work: work(), usage: null, commits: EMPTY_COMMITS, pulls: EMPTY_PULLS },
      6,
      NOW,
    );
    expect(quiet.shipped.pullsUnavailable).toBe(false);
  });
});
