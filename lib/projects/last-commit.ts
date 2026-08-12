import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * "Last worked on" for a project, read from its git history.
 *
 * ## Why this is cached hard
 *
 * The dashboard lists every project, so an uncached implementation spawns one
 * `git` per project on every load — 30 subprocesses on this machine, on the
 * page whose warm response is otherwise ~50ms. A commit time also barely
 * moves, so re-reading it per request buys nothing.
 *
 * Hence: one in-process entry per path, 5 minutes, refreshed lazily. Worst
 * case the ordering is five minutes stale, which for "which project did I
 * touch most recently" is indistinguishable from correct.
 */

const TTL_MS = 5 * 60 * 1000;
/** Per-call ceiling. A hung git must not hold the dashboard open. */
const GIT_TIMEOUT_MS = 2000;

const cache = new Map<string, { at: number; value: number | null }>();

/**
 * Unix seconds of the newest commit in `path`, or `null` when there isn't one
 * to read — not a git repo, path deleted, git missing, or git hung. Null is a
 * real answer here (an un-versioned project genuinely has no commit time), so
 * callers sort it last rather than treating it as an error.
 */
export async function lastCommitAt(path: string): Promise<number | null> {
  const now = Date.now();
  const hit = cache.get(path);
  if (hit && now - hit.at < TTL_MS) return hit.value;

  let value: number | null = null;
  try {
    const { stdout } = await run(
      "git",
      ["-C", path, "log", "-1", "--format=%ct"],
      { timeout: GIT_TIMEOUT_MS },
    );
    const parsed = Number.parseInt(stdout.trim(), 10);
    value = Number.isFinite(parsed) ? parsed : null;
  } catch {
    // Covers all of: not a repo, no commits yet, bad path, no git on PATH,
    // timeout. None of them are worth failing the projects list over.
    value = null;
  }

  cache.set(path, { at: now, value });
  return value;
}

/** Resolve many paths concurrently. Order of the returned map is irrelevant. */
export async function lastCommitForPaths(
  paths: string[],
): Promise<Map<string, number | null>> {
  const unique = [...new Set(paths)];
  const entries = await Promise.all(
    unique.map(async (path) => [path, await lastCommitAt(path)] as const),
  );
  return new Map(entries);
}
