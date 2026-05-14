import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";

const execFileP = promisify(execFile);

/**
 * Filesystem location for per-task worktrees. Lives outside the project
 * directory so `git status` in the user's main checkout stays clean and so
 * we have one consistent place to garbage-collect from later.
 */
function worktreeRoot(): string {
  return join(homedir(), ".drydock", "worktrees");
}

export function worktreePath(projectId: string, taskId: string): string {
  return join(worktreeRoot(), projectId, taskId);
}

/**
 * Returns true if `path` is inside a git working tree.
 *
 * We rely on `git -C <path> rev-parse --is-inside-work-tree` because it
 * handles every weird case correctly (symlinks, nested worktrees, bare
 * repos elsewhere) without us having to walk the filesystem ourselves.
 */
export async function isGitRepo(path: string): Promise<boolean> {
  try {
    const { stdout } = await execFileP("git", [
      "-C",
      path,
      "rev-parse",
      "--is-inside-work-tree",
    ]);
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

/**
 * Get the project repo's current HEAD branch name, or fall back to its
 * commit SHA if HEAD is detached. Used as the starting point for new
 * worktrees so each task forks from "wherever the user was."
 */
export async function getHeadRef(path: string): Promise<string> {
  // `--abbrev-ref HEAD` prints the branch name when on a branch, or "HEAD"
  // when detached. The fallback to `rev-parse HEAD` handles the detached
  // case by giving us the SHA the worktree can fork from.
  const { stdout: ref } = await execFileP("git", [
    "-C",
    path,
    "rev-parse",
    "--abbrev-ref",
    "HEAD",
  ]);
  const refName = ref.trim();
  if (refName !== "HEAD") return refName;
  const { stdout: sha } = await execFileP("git", [
    "-C",
    path,
    "rev-parse",
    "HEAD",
  ]);
  return sha.trim();
}

/**
 * Turn a task title into a git-safe slug we can append to a branch name.
 * Keeps the result short — long branch names get truncated by tools.
 */
export function slugifyForBranch(title: string): string {
  return (
    title
      .toLowerCase()
      // Replace anything that isn't alnum/hyphen with a hyphen.
      .replace(/[^a-z0-9]+/g, "-")
      // Trim leading/trailing hyphens.
      .replace(/^-+|-+$/g, "")
      // Cap length.
      .slice(0, 40) || "task"
  );
}

export interface CreateWorktreeInput {
  projectPath: string;
  projectId: string;
  taskId: string;
  taskTitle: string;
}

export interface CreateWorktreeResult {
  worktreePath: string;
  branch: string;
}

/**
 * Create a fresh git worktree for a task. Equivalent to
 * `git -C <project> worktree add -b <branch> <path> <base>`.
 *
 * - The branch name is `drydock/<task-id>-<slug>` — uniqueness comes from
 *   the task id, the slug exists for human readability in `git branch`.
 * - The base ref is whatever HEAD points to in the project repo at the
 *   moment of dispatch. The user is responsible for being on the right
 *   branch when they kick a task off; this is a deliberate choice so the
 *   tool doesn't second-guess them.
 *
 * If the worktree directory already exists from a previous run with the
 * same task id (shouldn't normally happen since task ids are unique, but
 * could after a retry of a task whose Phase-2 worktree path was kept) we
 * remove it first so `git worktree add` doesn't error out.
 */
export async function createWorktree(
  input: CreateWorktreeInput,
): Promise<CreateWorktreeResult> {
  const path = worktreePath(input.projectId, input.taskId);
  const slug = slugifyForBranch(input.taskTitle);
  const branch = `drydock/${input.taskId.slice(0, 8)}-${slug}`;
  const baseRef = await getHeadRef(input.projectPath);

  // Ensure parent dir exists (mkdir -p). git worktree add wants the leaf
  // directory not to exist; the parents must exist.
  await mkdir(join(worktreeRoot(), input.projectId), { recursive: true });
  // Best-effort cleanup of any leftover dir at the target path.
  await rm(path, { recursive: true, force: true });

  await execFileP("git", [
    "-C",
    input.projectPath,
    "worktree",
    "add",
    "-b",
    branch,
    path,
    baseRef,
  ]);

  return { worktreePath: path, branch };
}

/**
 * Tear down a worktree and (optionally) its branch.
 *
 * Phase 2 deliberately does NOT call this on success — we keep the worktree
 * around so the user can inspect the agent's changes and push a PR. Phase 3
 * may add an opt-in cleanup once quality gates can confidently merge.
 */
export async function removeWorktree(
  projectPath: string,
  path: string,
): Promise<void> {
  try {
    await execFileP("git", [
      "-C",
      projectPath,
      "worktree",
      "remove",
      "--force",
      path,
    ]);
  } catch {
    // If `git worktree remove` fails (e.g. the dir was deleted by hand),
    // fall back to removing the filesystem path so we don't leak disk.
    await rm(path, { recursive: true, force: true });
  }
}
