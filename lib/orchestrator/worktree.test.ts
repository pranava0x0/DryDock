import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  createWorktree,
  isGitRepo,
  removeWorktree,
  slugifyForBranch,
  worktreePath,
  getHeadRef,
} from "./worktree";

const execFileP = promisify(execFile);

// Tests that need a real worktree to be created have to live under the
// production worktree root (~/.drydock/worktrees). The fixture below
// captures every path we create so we can tear it down cleanly.
const createdPaths: string[] = [];

let projectDir: string;

beforeEach(async () => {
  // Spin up a tiny git repo to act as the "project."
  projectDir = mkdtempSync(join(tmpdir(), "drydock-wt-project-"));
  await execFileP("git", ["-C", projectDir, "init", "-q"]);
  await execFileP("git", ["-C", projectDir, "config", "user.email", "t@t.test"]);
  await execFileP("git", ["-C", projectDir, "config", "user.name", "Tester"]);
  writeFileSync(join(projectDir, "README"), "hello\n");
  await execFileP("git", ["-C", projectDir, "add", "README"]);
  await execFileP("git", ["-C", projectDir, "commit", "-qm", "init"]);
});

afterEach(async () => {
  // Best-effort cleanup: prune git's tracking of removed worktrees, then
  // remove the project repo itself.
  for (const p of createdPaths) {
    try {
      await removeWorktree(projectDir, p);
    } catch {
      // ignore — afterEach should never fail a test
    }
  }
  createdPaths.length = 0;
  await rm(projectDir, { recursive: true, force: true });
});

describe("slugifyForBranch", () => {
  it("lowercases, removes non-alnum, caps length", () => {
    expect(slugifyForBranch("Add Dark Mode!!!")).toBe("add-dark-mode");
    expect(slugifyForBranch("  Fix:  the   thing  ")).toBe("fix-the-thing");
    expect(slugifyForBranch("a".repeat(100))).toHaveLength(40);
  });

  it("falls back to 'task' for empty/garbage input", () => {
    expect(slugifyForBranch("")).toBe("task");
    expect(slugifyForBranch("!!!")).toBe("task");
    expect(slugifyForBranch("   ")).toBe("task");
  });
});

describe("isGitRepo", () => {
  it("returns true for an initialized git working tree", async () => {
    expect(await isGitRepo(projectDir)).toBe(true);
  });

  it("returns false for a plain directory", async () => {
    const plain = mkdtempSync(join(tmpdir(), "drydock-plain-"));
    try {
      expect(await isGitRepo(plain)).toBe(false);
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });

  it("returns false for a nonexistent path", async () => {
    expect(await isGitRepo("/tmp/does-not-exist-xyz123")).toBe(false);
  });
});

describe("getHeadRef", () => {
  it("returns the branch name when on a branch", async () => {
    const ref = await getHeadRef(projectDir);
    // `git init` defaults vary by git version (master vs. main) so accept either.
    expect(["main", "master"]).toContain(ref);
  });

  it("returns a SHA when HEAD is detached", async () => {
    const { stdout: sha } = await execFileP("git", [
      "-C",
      projectDir,
      "rev-parse",
      "HEAD",
    ]);
    await execFileP("git", ["-C", projectDir, "checkout", "-q", "--detach"]);
    const ref = await getHeadRef(projectDir);
    expect(ref).toBe(sha.trim());
  });
});

describe("createWorktree", () => {
  it("creates a fresh branch + working tree under ~/.drydock", async () => {
    const taskId = "abcd1234ef";
    const result = await createWorktree({
      projectPath: projectDir,
      projectId: "proj1",
      taskId,
      taskTitle: "Add dark mode",
    });
    createdPaths.push(result.worktreePath);

    // The path should live under the canonical worktree root.
    expect(result.worktreePath).toBe(worktreePath("proj1", taskId));
    expect(result.worktreePath.startsWith(homedir())).toBe(true);
    expect(existsSync(join(result.worktreePath, "README"))).toBe(true);

    // Branch name includes a slice of the task id (so it stays unique even
    // if two task titles slug to the same string) and the human-readable slug.
    expect(result.branch).toMatch(/^drydock\/abcd1234-add-dark-mode$/);

    // Confirm git itself knows about this worktree.
    const { stdout } = await execFileP("git", [
      "-C",
      projectDir,
      "worktree",
      "list",
      "--porcelain",
    ]);
    expect(stdout).toContain(result.worktreePath);
    expect(stdout).toContain(`branch refs/heads/${result.branch}`);
  });

  it("recreates the worktree dir even if a stale one exists", async () => {
    const taskId = "stale0001";
    const first = await createWorktree({
      projectPath: projectDir,
      projectId: "proj2",
      taskId,
      taskTitle: "first",
    });
    createdPaths.push(first.worktreePath);

    // Drop the worktree entry but leave the directory behind to simulate a
    // process killed mid-run. The next createWorktree call must recover.
    await execFileP("git", [
      "-C",
      projectDir,
      "worktree",
      "remove",
      "--force",
      first.worktreePath,
    ]);
    // Re-create a clean checkout — same task id, different title.
    const second = await createWorktree({
      projectPath: projectDir,
      projectId: "proj2",
      taskId,
      taskTitle: "second try",
    });
    createdPaths.push(second.worktreePath);
    expect(existsSync(second.worktreePath)).toBe(true);
  });
});

describe("removeWorktree", () => {
  it("removes the worktree directory and prunes git state", async () => {
    const result = await createWorktree({
      projectPath: projectDir,
      projectId: "proj3",
      taskId: "rem00001",
      taskTitle: "to be removed",
    });
    expect(existsSync(result.worktreePath)).toBe(true);
    await removeWorktree(projectDir, result.worktreePath);
    expect(existsSync(result.worktreePath)).toBe(false);
  });
});
