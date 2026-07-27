import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { branchFromRefs, scanFlow, scanRepoCommits } from "./git-flow";

const run = promisify(execFile);

/**
 * These build real git repositories in a temp dir rather than mocking
 * `git log`. The parser's whole job is surviving git's actual output
 * format — separators, the numstat block, empty bodies, binary files —
 * and a mock would only ever assert what the mock was written to say.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "drydock-flow-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function makeRepo(name: string): Promise<string> {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  await run("git", ["init", "-q", "-b", "main"], { cwd: path });
  await run("git", ["config", "user.email", "me@example.com"], { cwd: path });
  await run("git", ["config", "user.name", "Me"], { cwd: path });
  await run("git", ["config", "commit.gpgsign", "false"], { cwd: path });
  return path;
}

async function commit(
  path: string,
  file: string,
  content: string,
  message: string,
): Promise<void> {
  writeFileSync(join(path, file), content);
  await run("git", ["add", "-A"], { cwd: path });
  await run("git", ["commit", "-q", "-m", message], { cwd: path });
}

describe("scanRepoCommits", () => {
  it("parses subject, author, and line counts from real git output", async () => {
    const path = await makeRepo("alpha");
    await commit(path, "a.txt", "one\ntwo\nthree\n", "feat: add a file");

    const flow = await scanRepoCommits(path, "alpha", 30);
    expect(flow.reason).toBeNull();
    expect(flow.commits).toHaveLength(1);
    const [c] = flow.commits;
    expect(c.subject).toBe("feat: add a file");
    expect(c.authorName).toBe("Me");
    expect(c.additions).toBe(3);
    expect(c.deletions).toBe(0);
    expect(c.agent).toBe("human");
  });

  it("attributes a commit from its trailer, model included", async () => {
    const path = await makeRepo("bravo");
    await commit(
      path,
      "a.txt",
      "x\n",
      "feat: agent work\n\nCo-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>",
    );

    const [c] = (await scanRepoCommits(path, "bravo", 30)).commits;
    expect(c.agent).toBe("claude");
    expect(c.model).toBe("Opus 4.7");
    expect(c.source).toBe("trailer");
  });

  it("does not mistake a human co-author for an agent", async () => {
    const path = await makeRepo("charlie");
    await commit(
      path,
      "a.txt",
      "x\n",
      "fix: pairing\n\nCo-authored-by: Pranava Raparla <pranava@local>",
    );

    const [c] = (await scanRepoCommits(path, "charlie", 30)).commits;
    expect(c.agent).toBe("human");
  });

  it("counts commits on unmerged agent branches", async () => {
    // `--all`: work on `claude/*` and `jam/*` branches is exactly what
    // this feature exists to measure, and it usually hasn't merged yet.
    const path = await makeRepo("delta");
    await commit(path, "a.txt", "x\n", "chore: base");
    await run("git", ["checkout", "-q", "-b", "claude/feature"], { cwd: path });
    await commit(path, "b.txt", "y\n", "feat: on a branch");
    await run("git", ["checkout", "-q", "main"], { cwd: path });

    const flow = await scanRepoCommits(path, "delta", 30);
    expect(flow.commits).toHaveLength(2);
    expect(flow.commits.some((c) => c.agent === "claude")).toBe(true);
  });

  it("excludes merge commits", async () => {
    // A merge's diffstat double-counts both sides and carries no
    // trailer; including them inflates every line count.
    const path = await makeRepo("echo");
    await commit(path, "a.txt", "x\n", "chore: base");
    await run("git", ["checkout", "-q", "-b", "side"], { cwd: path });
    await commit(path, "b.txt", "y\n", "feat: side work");
    await run("git", ["checkout", "-q", "main"], { cwd: path });
    await commit(path, "c.txt", "z\n", "feat: main work");
    await run("git", ["merge", "-q", "--no-ff", "-m", "Merge side", "side"], {
      cwd: path,
    });

    const flow = await scanRepoCommits(path, "echo", 30);
    expect(flow.commits.map((c) => c.subject)).not.toContain("Merge side");
    expect(flow.commits).toHaveLength(3);
  });

  it("handles a multi-line body without losing the numstat", async () => {
    const path = await makeRepo("foxtrot");
    await commit(
      path,
      "a.txt",
      "1\n2\n3\n4\n5\n",
      [
        "feat: big change",
        "",
        "A body paragraph.",
        "",
        "Another paragraph with a - dash line.",
        "",
        "Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>",
      ].join("\n"),
    );

    const [c] = (await scanRepoCommits(path, "foxtrot", 30)).commits;
    expect(c.additions).toBe(5);
    expect(c.model).toBe("Haiku 4.5");
  });

  it("reports a non-repo directory instead of throwing", async () => {
    const path = join(root, "not-a-repo");
    mkdirSync(path, { recursive: true });
    const flow = await scanRepoCommits(path, "not-a-repo", 30);
    expect(flow.commits).toEqual([]);
    expect(flow.reason).toContain("not a git repository");
  });
});

describe("branchFromRefs", () => {
  it("strips the HEAD arrow", () => {
    expect(branchFromRefs("HEAD -> main, origin/main")).toBe("main");
  });

  it("prefers an agent-prefixed branch when several refs point here", () => {
    expect(branchFromRefs("HEAD -> main, origin/claude/thing")).toBe(
      "origin/claude/thing",
    );
  });

  it("ignores tags", () => {
    expect(branchFromRefs("tag: v1.0.0")).toBeNull();
  });

  it("returns null for no decoration", () => {
    expect(branchFromRefs("")).toBeNull();
    expect(branchFromRefs("   ")).toBeNull();
  });
});

describe("scanFlow", () => {
  it("sweeps every git repo one level under the root", async () => {
    await makeRepo("one").then((p) => commit(p, "a.txt", "x\n", "feat: one"));
    await makeRepo("two").then((p) => commit(p, "a.txt", "x\n", "feat: two"));
    mkdirSync(join(root, "not-a-repo"), { recursive: true });

    const scan = await scanFlow(30, root);
    expect(scan.reposRead).toBe(2);
    expect(scan.commits).toHaveLength(2);
    expect(scan.repos.map((r) => r.repo).sort()).toEqual(["one", "two"]);
  });

  it("says why rather than returning an empty sweep for a bad root", async () => {
    const scan = await scanFlow(30, join(root, "nope"));
    expect(scan.commits).toEqual([]);
    expect(scan.reason).toContain("DRYDOCK_PROJECTS_ROOT");
  });

  it("skips hidden directories", async () => {
    await makeRepo(".hidden").then((p) =>
      commit(p, "a.txt", "x\n", "feat: hidden"),
    );
    const scan = await scanFlow(30, root);
    expect(scan.reposRead).toBe(0);
  });
});
