import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Regression tests for scripts/branch-merge-state.sh.
 *
 * This repo squash-merges every PR, which makes "commits ahead of main" a
 * useless measure of whether a branch has work left in it: the squash writes
 * one new commit onto main and leaves every original SHA unreachable, so a
 * fully-shipped branch still reports its whole count. The daily sweep used to
 * report exactly that, manufacturing a false "10 commits not in main" finding
 * roughly once per run.
 *
 * Two attempted fixes shipped and were caught in review on the same day (see
 * docs/daily-sweep-log.md, 2026-08-12), both because they were only ever
 * exercised against the one history that happened to be on disk. Every case
 * below is a *topology*, built from scratch, so the next attempt has to survive
 * all of them rather than today's repo.
 */

const SCRIPT = resolve(__dirname, "../../scripts/branch-merge-state.sh");

let root: string;

/** Absolute and deliberately outside the repo — never derived from a real path. */
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "drydock-branch-state-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

let seq = 0;

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    },
  }).trim();
}

/** A fresh repo with one commit on main. */
function newRepo(): string {
  const repo = join(root, `r${seq++}`);
  execFileSync("mkdir", ["-p", repo]);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "base");
  return repo;
}

function commit(repo: string, file: string, contents: string, msg: string) {
  writeFileSync(join(repo, file), contents);
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", msg);
}

/** How this repo lands every PR. */
function squashMerge(repo: string, branch: string, msg: string) {
  git(repo, "checkout", "-q", "main");
  git(repo, "merge", "-q", "--squash", branch);
  git(repo, "commit", "-q", "-m", msg);
}

function state(repo: string, branch: string): string {
  return execFileSync(SCRIPT, [repo, branch], { encoding: "utf8" }).trim();
}

describe("branch-merge-state.sh", () => {
  it("reports a branch with no commits ahead as in-sync", () => {
    const repo = newRepo();
    git(repo, "branch", "feat");
    expect(state(repo, "feat")).toBe("in-sync");
  });

  it("reports genuinely unmerged work, with its commit count", () => {
    const repo = newRepo();
    git(repo, "checkout", "-q", "-b", "feat");
    commit(repo, "a.txt", "work\n", "w1");
    commit(repo, "a.txt", "work more\n", "w2");
    git(repo, "checkout", "-q", "main");
    expect(state(repo, "feat")).toBe("unmerged 2");
  });

  it("calls a squash-merged branch stale even though its SHAs are unreachable from main", () => {
    const repo = newRepo();
    git(repo, "checkout", "-q", "-b", "feat");
    commit(repo, "a.txt", "work\n", "w1");
    commit(repo, "a.txt", "work more\n", "w2");
    squashMerge(repo, "feat", "squash of feat (#1)");
    // The whole point: the count is nonzero and completely uninformative.
    expect(git(repo, "rev-list", "--count", "main..feat")).toBe("2");
    expect(state(repo, "feat")).toBe("stale 2");
  });

  /**
   * The first shipped fix compared the branch tree to main's *tip*, which held
   * only while the squash being detected was the newest commit. One unrelated
   * commit later it flipped back to the false positive — and merging the PR
   * that carried the fix would have been that commit.
   */
  it("stays stale after main advances past the squash merge", () => {
    const repo = newRepo();
    git(repo, "checkout", "-q", "-b", "feat");
    commit(repo, "a.txt", "work\n", "w1");
    squashMerge(repo, "feat", "squash of feat (#1)");
    commit(repo, "unrelated.txt", "later\n", "an unrelated later commit");
    commit(repo, "unrelated2.txt", "later still\n", "another one");
    expect(state(repo, "feat")).toBe("stale 1");
  });

  /**
   * The second shipped fix used a patch-id replay, which a branch that merges
   * main back in defeats: the merge base moves onto the squash commit, so the
   * synthesized probe is an *empty* commit, which `git cherry` correctly
   * reports as `+` (no equivalent upstream). Nothing left to merge, reported as
   * work. Hence the merge-base emptiness check running first.
   */
  it("stays stale when the branch has merged main back in since being squashed", () => {
    const repo = newRepo();
    git(repo, "checkout", "-q", "-b", "feat");
    commit(repo, "a.txt", "work\n", "w1");
    squashMerge(repo, "feat", "squash of feat (#1)");
    commit(repo, "unrelated.txt", "later\n", "an unrelated later commit");
    git(repo, "checkout", "-q", "feat");
    git(repo, "merge", "-q", "main", "-m", "merge main into feat");
    git(repo, "checkout", "-q", "main");
    // The original commit plus the merge commit — neither reachable from main.
    expect(git(repo, "rev-list", "--count", "main..feat")).toBe("2");
    expect(state(repo, "feat")).toBe("stale 2");
  });

  it("still reports work added to a branch after its squash merge", () => {
    const repo = newRepo();
    git(repo, "checkout", "-q", "-b", "feat");
    commit(repo, "a.txt", "work\n", "w1");
    squashMerge(repo, "feat", "squash of feat (#1)");
    git(repo, "checkout", "-q", "feat");
    commit(repo, "a.txt", "work plus more\n", "added after the squash");
    git(repo, "checkout", "-q", "main");
    expect(state(repo, "feat")).toBe("unmerged 2");
  });

  /**
   * A repo with no common ancestor is a real local state here — the sweep
   * filed one against Brownfield Opportunities. It must not read as shipped.
   */
  it("reports unmerged when there is no common ancestor", () => {
    const repo = newRepo();
    git(repo, "checkout", "-q", "--orphan", "feat");
    git(repo, "rm", "-q", "-rf", ".");
    commit(repo, "other.txt", "unrelated history\n", "orphan root");
    git(repo, "checkout", "-q", "main");
    expect(state(repo, "feat")).toMatch(/^unmerged \d+$/);
  });

  /**
   * The very first attempt tested `[ -z "$(git diff --stat …)" ]`, where a
   * *failed* git call produces empty stdout and reads as "no differences" —
   * the unhappy path rendering identically to the happy one. A branch that
   * cannot be compared must report its work, never silently pass as shipped.
   */
  it("does not report an unreadable branch as stale", () => {
    const repo = newRepo();
    expect(state(repo, "no-such-branch")).not.toContain("stale");
  });
});
