import { execFile } from "node:child_process";
import { promises as fs, type Dirent } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  attributeCommit,
  type Agent,
  type AttributionSource,
} from "../insights/attribution";
import { localDayKey } from "../util/day";

/**
 * Code-flow collection from **local git clones** (EP-11 Spec A).
 *
 * ── Why local git and not the GitHub API ────────────────────────────────
 * The plan specified `gh api graphql`. Reading the clones directly turned
 * out to be strictly better for this job, for three reasons:
 *
 * 1. **Attribution needs full message bodies.** Trailers live in the
 *    body, and GitHub's commit-search results don't reliably carry it.
 *    Without bodies there is no model breakdown at all — which is most
 *    of what the Flow tab is for.
 * 2. **Private repos come free.** No scope question, no
 *    `restrictedContributionsCount` caveat: if it's cloned, it's
 *    readable.
 * 3. **No rate limit and no network.** A 34-repo sweep is local disk.
 *
 * The trade: repos that aren't cloned here are invisible. That's an
 * honest, *visible* limit — the summary reports how many repos it read —
 * rather than the invisible one the API path would have (a body that
 * silently isn't there).
 *
 * Everything is read-only: `git log` and nothing else. No fetch, no
 * checkout, no writes of any kind into the user's repos.
 */

const GIT_TIMEOUT_MS = 20_000;
const MAX_BUFFER = 32 * 1024 * 1024;

/** Field separator — a control char that can't occur in a commit message. */
const FIELD = "";
/** Record separator. */
const RECORD = "";

export interface FlowCommit {
  sha: string;
  repo: string;
  /** Local `YYYY-MM-DD`. */
  day: string;
  /** Local hour 0–23, for the punch card. */
  hour: number;
  authoredAt: number;
  authorName: string;
  authorEmail: string;
  subject: string;
  agent: Agent;
  model: string;
  source: AttributionSource;
  additions: number;
  deletions: number;
}

export interface RepoFlow {
  repo: string;
  path: string;
  commits: FlowCommit[];
  reason: string | null;
}

export interface FlowScan {
  repos: RepoFlow[];
  commits: FlowCommit[];
  /** Repos that were readable. */
  reposRead: number;
  /** Directories that looked like projects but weren't git repos. */
  nonRepos: number;
  root: string;
  reason: string | null;
}

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BUFFER, env: process.env },
      (error, stdout) => resolve(error ? null : stdout),
    );
  });
}

/**
 * Read one repository's recent commits.
 *
 * `--no-merges` because a merge commit's diffstat double-counts the work
 * on both sides and its message carries no trailer — including them
 * would inflate every line count and dilute the AI share with commits
 * nobody authored.
 *
 * `--all` so work on unmerged agent branches (`claude/*`, `jam/*`,
 * `drydock/*`) is counted. Restricting to the checked-out branch would
 * miss precisely the commits this feature exists to measure.
 */
export async function scanRepoCommits(
  repoPath: string,
  repoName: string,
  sinceDays: number,
): Promise<RepoFlow> {
  const format = [
    "%H",
    "%at",
    "%an",
    "%ae",
    "%s",
    "%D", // ref names, when the commit is a branch tip
    "%b",
  ].join(FIELD);

  const out = await git(repoPath, [
    "log",
    "--all",
    "--no-merges",
    `--since=${sinceDays}.days.ago`,
    `--pretty=format:${RECORD}${format}`,
    "--numstat",
  ]);
  if (out === null) {
    return {
      repo: repoName,
      path: repoPath,
      commits: [],
      reason: "not a git repository, or git could not read it",
    };
  }

  const commits: FlowCommit[] = [];
  for (const chunk of out.split(RECORD)) {
    if (chunk.trim().length === 0) continue;
    const parsed = parseCommitChunk(chunk, repoName);
    if (parsed) commits.push(parsed);
  }
  return { repo: repoName, path: repoPath, commits, reason: null };
}

function parseCommitChunk(chunk: string, repo: string): FlowCommit | null {
  const fields = chunk.split(FIELD);
  if (fields.length < 7) return null;
  const [sha, atRaw, authorName, authorEmail, subject, refs] = fields;
  // The body and the numstat block share the last field, separated by the
  // blank line git puts between them.
  const rest = fields.slice(6).join(FIELD);

  const at = Number.parseInt(atRaw, 10);
  if (!Number.isFinite(at)) return null;
  const date = new Date(at * 1000);

  // numstat lines are `<added>\t<deleted>\t<path>`; binary files use "-".
  let additions = 0;
  let deletions = 0;
  const bodyLines: string[] = [];
  for (const line of rest.split("\n")) {
    const stat = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (stat) {
      additions += stat[1] === "-" ? 0 : Number.parseInt(stat[1], 10);
      deletions += stat[2] === "-" ? 0 : Number.parseInt(stat[2], 10);
      continue;
    }
    bodyLines.push(line);
  }
  const body = bodyLines.join("\n");

  const attribution = attributeCommit({
    message: `${subject}\n\n${body}`,
    branch: branchFromRefs(refs),
  });

  return {
    sha: sha.trim(),
    repo,
    day: localDayKey(date),
    hour: date.getHours(),
    authoredAt: at,
    authorName,
    authorEmail,
    subject,
    agent: attribution.agent,
    model: attribution.model,
    source: attribution.source,
    additions,
    deletions,
  };
}

/**
 * Pick a usable branch name out of git's `%D` decoration.
 *
 * `%D` only decorates branch *tips*, so most commits get nothing — which
 * is fine, since the branch rule is the weakest signal anyway and only
 * fires when no trailer did. Prefer a local agent-prefixed branch when
 * several refs point here, because that's the one that carries meaning.
 */
export function branchFromRefs(refs: string): string | null {
  if (!refs || refs.trim().length === 0) return null;
  const names = refs
    .split(",")
    .map((r) => r.trim().replace(/^HEAD -> /, ""))
    .filter((r) => r.length > 0 && !r.startsWith("tag: "));
  if (names.length === 0) return null;
  const agentish = names.find((n) =>
    /(^|\/)(drydock|claude|codex|jam)\//.test(n),
  );
  return agentish ?? names[0];
}

/** Default scan root, matching the discovery page's convention. */
export function projectsRoot(): string {
  return (
    process.env.DRYDOCK_PROJECTS_ROOT ?? join(homedir(), "Projects")
  );
}

/**
 * Sweep every git repo one level under the projects root.
 *
 * One level deep, same as the discovery scan: each child of the root is a
 * project. Going deeper would start pulling in vendored repos inside
 * `node_modules`.
 */
export async function scanFlow(
  sinceDays = 90,
  root: string = projectsRoot(),
): Promise<FlowScan> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return {
      repos: [],
      commits: [],
      reposRead: 0,
      nonRepos: 0,
      root,
      reason: `could not read ${root} — set DRYDOCK_PROJECTS_ROOT if your projects live elsewhere`,
    };
  }

  const dirs = entries.filter(
    (e) => e.isDirectory() && !e.name.startsWith("."),
  );

  const scans = await Promise.all(
    dirs.map(async (dir) => {
      const path = join(root, dir.name);
      try {
        await fs.stat(join(path, ".git"));
      } catch {
        return null;
      }
      return scanRepoCommits(path, dir.name, sinceDays);
    }),
  );

  const repos = scans.filter((s): s is RepoFlow => s !== null);
  return {
    repos,
    commits: repos.flatMap((r) => r.commits),
    reposRead: repos.filter((r) => r.reason === null).length,
    nonRepos: dirs.length - repos.length,
    root,
    reason: null,
  };
}
