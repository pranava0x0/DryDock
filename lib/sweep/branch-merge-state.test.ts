import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
 * Four attempted fixes were caught in review on the same day (see
 * docs/daily-sweep-log.md, 2026-08-12), every one of them because it was only
 * ever exercised against the history that happened to be on disk. Each case
 * below is therefore a *topology*, built from scratch, so the next attempt has
 * to survive all of them rather than today's repo.
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
   * The patch-id replay was wrong whenever main edited the same region before
   * the squash: the squash commit's diff is against already-modified main,
   * the probe's is against the old fork point, and differing context lines
   * mean differing patch-ids. Note the two edits have to fall within each
   * other's diff context to trigger it — an earlier attempt at this fixture
   * put them six lines apart and passed against the broken code.
   */
  it("stays stale when main edited the same region of the file before the squash", () => {
    const repo = newRepo();
    writeFileSync(join(repo, "shared.txt"), "a\nb\nc\nd\ne\nf\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "shared file");
    git(repo, "checkout", "-q", "-b", "feat");
    commit(repo, "shared.txt", "a\nb\nc\nd\ne\nBRANCH\n", "branch edits line 6");
    git(repo, "checkout", "-q", "main");
    commit(repo, "shared.txt", "a\nb\nc\nMAIN\ne\nf\n", "main edits line 4 first");
    squashMerge(repo, "feat", "squash of feat (#1)");
    expect(state(repo, "feat")).toBe("stale 1");
  });

  /**
   * The merge-tree test alone is blind here: once main revises a path the
   * branch touched, merging the stale branch back in changes the tree (or
   * conflicts), so a fully-shipped branch reads as outstanding work. Ordinary
   * history — it happens the first time anyone edits that file again. The
   * historical patch-id replay is what covers it.
   */
  it("stays stale when main revised the branch's file after the squash", () => {
    const repo = newRepo();
    git(repo, "checkout", "-q", "-b", "feat");
    commit(repo, "x.txt", "branch version\n", "branch edits x");
    squashMerge(repo, "feat", "squash of feat (#1)");
    commit(repo, "x.txt", "revised on main afterwards\n", "main revises x");
    expect(state(repo, "feat")).toBe("stale 1");
  });

  it("stays stale when main deleted the branch's file after the squash", () => {
    const repo = newRepo();
    git(repo, "checkout", "-q", "-b", "feat");
    commit(repo, "x.txt", "branch version\n", "branch adds x");
    squashMerge(repo, "feat", "squash of feat (#1)");
    git(repo, "rm", "-q", "x.txt");
    git(repo, "commit", "-q", "-m", "main deletes x after the squash");
    expect(state(repo, "feat")).toBe("stale 1");
  });

  /**
   * `git patch-id` ignores whitespace by default, so `git cherry` called a
   * branch adding `foobar` equivalent to a main commit adding `foo bar` — and
   * the helper reported real, conflicting work as shipped. That is the one
   * direction this script must never fail in: `stale` means the sweep stops
   * mentioning the branch, so hidden work stays hidden. Hence --verbatim.
   */
  it("does not treat a whitespace-equivalent patch on main as incorporation", () => {
    const repo = newRepo();
    git(repo, "checkout", "-q", "-b", "feat");
    commit(repo, "base.txt", "base\nfoobar\n", "branch adds foobar");
    git(repo, "checkout", "-q", "main");
    commit(repo, "base.txt", "base\nfoo bar\n", "main adds foo bar");
    expect(state(repo, "feat")).toBe("unmerged 1");
  });

  /**
   * Both refs and the commit count resolve; only a tree object is gone. The
   * `git diff --quiet` exit status is then 128, and treating that like an
   * ordinary "they differ" (1) reported a partial read as real work.
   */
  it("reports unreadable when a tree object is missing", () => {
    const repo = newRepo();
    git(repo, "checkout", "-q", "-b", "feat");
    commit(repo, "a.txt", "work\n", "w1");
    const tree = git(repo, "rev-parse", "feat^{tree}");
    // Back to main *first*: once the tree is gone, checking it out fails too.
    git(repo, "checkout", "-q", "main");
    rmSync(join(repo, ".git", "objects", tree.slice(0, 2), tree.slice(2)), { force: true });
    expect(state(repo, "feat")).toBe("unreadable");
  });

  it("reports unmerged when the branch would conflict with main", () => {
    const repo = newRepo();
    git(repo, "checkout", "-q", "-b", "feat");
    commit(repo, "base.txt", "branch version\n", "branch rewrites base");
    git(repo, "checkout", "-q", "main");
    commit(repo, "base.txt", "main version\n", "main rewrites base");
    expect(state(repo, "feat")).toBe("unmerged 1");
  });

  /**
   * The very first attempt tested `[ -z "$(git diff --stat …)" ]`, where a
   * *failed* git call produces empty stdout and reads as "no differences" —
   * the unhappy path rendering identically to the happy one. A ref that cannot
   * be read must say so: reporting it as `in-sync` made the sweep skip the
   * branch entirely, which is the same failure wearing a different label.
   */
  it("reports an unreadable branch as unreadable, not in-sync or stale", () => {
    const repo = newRepo();
    expect(state(repo, "no-such-branch")).toBe("unreadable");
  });

  it("reports an unreadable base as unreadable", () => {
    const repo = newRepo();
    git(repo, "checkout", "-q", "-b", "feat");
    commit(repo, "a.txt", "work\n", "w1");
    expect(
      execFileSync(SCRIPT, [repo, "feat", "no-such-base"], { encoding: "utf8" }).trim(),
    ).toBe("unreadable");
  });
});
