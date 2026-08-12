import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Per-project commit activity for a recent window, read straight from git.
 *
 * Same caching discipline as last-commit.ts and for the same reason: one
 * `git` per project, on the app's landing page, across 30 projects. The
 * window is a whole number of days and commit history doesn't rewrite
 * itself, so a few minutes of staleness is invisible.
 */

const TTL_MS = 5 * 60 * 1000;
const GIT_TIMEOUT_MS = 3000;
/** Subjects kept per project — enough to show a history, not a changelog. */
const MAX_SUBJECTS = 5;

export interface ProjectCommitActivity {
  path: string;
  /** Commits in the window. 0 for a repo with none, null-safe by design. */
  count: number;
  /** Unix seconds of the newest commit in the window, or null if none. */
  latestAt: number | null;
  /** Newest-first commit subjects, capped at MAX_SUBJECTS. */
  subjects: string[];
  /** True when the path isn't a readable git repo at all. */
  unavailable: boolean;
}

const cache = new Map<string, { at: number; value: ProjectCommitActivity }>();

/**
 * Commits in `path` since `sinceDays` ago.
 *
 * Counts every commit in the repo, not only ones matching your git identity.
 * On a personal machine those are the same thing in practice, and filtering
 * by `--author` would silently drop work committed under a second email or
 * co-authored by a bot — an undercount that looks exactly like a quiet week.
 */
export async function commitActivityFor(
  path: string,
  sinceDays = 7,
): Promise<ProjectCommitActivity> {
  const key = `${path}::${sinceDays}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.value;

  let value: ProjectCommitActivity = {
    path,
    count: 0,
    latestAt: null,
    subjects: [],
    unavailable: true,
  };

  try {
    const { stdout } = await run(
      "git",
      [
        "-C",
        path,
        "log",
        `--since=${sinceDays} days ago`,
        "--format=%ct%x09%s",
      ],
      { timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
    );

    const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
    const parsed = lines.map((line) => {
      const tab = line.indexOf("\t");
      const at = Number.parseInt(line.slice(0, tab), 10);
      return {
        at: Number.isFinite(at) ? at : null,
        subject: line.slice(tab + 1).trim(),
      };
    });

    value = {
      path,
      count: parsed.length,
      // `git log` is newest-first, so the first parseable stamp is the latest.
      latestAt: parsed.find((p) => p.at !== null)?.at ?? null,
      subjects: parsed.slice(0, MAX_SUBJECTS).map((p) => p.subject),
      // A repo with zero commits this week is available-and-quiet, which is
      // a different fact from "not a repo". Only a throw means unavailable.
      unavailable: false,
    };
  } catch {
    // Not a repo, no git, bad path, or timeout — all reported as unavailable
    // rather than as a zero, so the UI never renders "0 commits" for a
    // project it simply failed to read.
    value = { path, count: 0, latestAt: null, subjects: [], unavailable: true };
  }

  cache.set(key, { at: now, value });
  return value;
}

export interface CommitSummary {
  /** Commits across every readable repo in the window. */
  totalCommits: number;
  /** Repos with at least one commit in the window. */
  activeRepos: number;
  /** Repos we could not read at all. */
  unavailableRepos: number;
  /** Busiest first, only repos with commits. */
  byProject: Array<{ path: string; count: number; subjects: string[] }>;
}

/** Aggregate commit activity across many project paths, concurrently. */
export async function commitSummaryFor(
  paths: string[],
  sinceDays = 7,
): Promise<CommitSummary> {
  const unique = [...new Set(paths)];
  const results = await Promise.all(
    unique.map((path) => commitActivityFor(path, sinceDays)),
  );

  const withCommits = results
    .filter((r) => !r.unavailable && r.count > 0)
    .sort((a, b) => b.count - a.count)
    .map((r) => ({ path: r.path, count: r.count, subjects: r.subjects }));

  return {
    totalCommits: results.reduce((sum, r) => sum + r.count, 0),
    activeRepos: withCommits.length,
    unavailableRepos: results.filter((r) => r.unavailable).length,
    byProject: withCommits,
  };
}
