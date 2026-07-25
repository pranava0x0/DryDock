import { execFile } from "node:child_process";

/**
 * Thin wrapper around the `gh` CLI.
 *
 * ── Why a subprocess and not the GitHub API ─────────────────────────────
 * Same reason the dispatcher shells out to `claude`: **no API keys, ever**
 * (AGENTS.md). `gh` already holds the user's OAuth token in its own
 * keychain entry, scoped how they scoped it, revocable where they expect.
 * Reading that token into DryDock — or asking for a second one — would
 * create a secret this app has to store, rotate, and be trusted with. A
 * subprocess borrows the credential without ever seeing it.
 *
 * Every call goes through `execFile` with an argv array, never a shell
 * string, so a repo or branch name containing a quote or a semicolon is
 * an argument rather than a command.
 */

/** GitHub calls happen on a dashboard read; don't hang the page. */
const DEFAULT_TIMEOUT_MS = 15_000;

/** Bounded so a pathological response can't exhaust memory. */
const MAX_BUFFER = 8 * 1024 * 1024;

export interface GhResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** Set when the call failed, phrased for a health chip. */
  reason: string | null;
}

export function runGh(
  args: string[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<GhResult> {
  return new Promise<GhResult>((resolve) => {
    execFile(
      "gh",
      args,
      {
        timeout: timeoutMs,
        maxBuffer: MAX_BUFFER,
        // Inherit the environment so `gh` finds its own config and
        // keychain entry. Nothing is added.
        env: process.env,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ ok: true, stdout, stderr, reason: null });
          return;
        }
        resolve({
          ok: false,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          reason: explain(error as ExecFileError, stderr ?? ""),
        });
      },
    );
  });
}

/**
 * What `execFile` actually hands back on failure. Node's own typings
 * describe this as `ExecFileException`, whose `code` is `string | number`
 * and which carries `killed`/`signal` that `ErrnoException` doesn't.
 */
interface ExecFileError extends Error {
  code?: string | number | null;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
}

/**
 * Turn a subprocess failure into something a health chip can show.
 * "ENOENT" and a raw stack are not answers a user can act on; "the gh CLI
 * isn't installed" is.
 */
function explain(error: ExecFileError, stderr: string): string {
  if (error.code === "ENOENT") {
    return "the `gh` CLI is not installed or not on PATH";
  }
  if (error.killed || error.signal === "SIGTERM") {
    return "`gh` timed out";
  }
  const tail = stderr.trim().split("\n").slice(-2).join(" ").trim();
  if (/not logged|authentication|gh auth login/i.test(tail)) {
    return "`gh` is not authenticated — run `gh auth login`";
  }
  if (/rate limit/i.test(tail)) {
    return "GitHub API rate limit reached";
  }
  return tail.length > 0 ? tail : `gh exited with code ${error.code ?? "?"}`;
}

/** Run `gh` and parse its `--json` output. */
export async function runGhJson<T>(
  args: string[],
  timeoutMs?: number,
): Promise<{ ok: boolean; data: T | null; reason: string | null }> {
  const result = await runGh(args, timeoutMs);
  if (!result.ok) return { ok: false, data: null, reason: result.reason };
  try {
    return { ok: true, data: JSON.parse(result.stdout) as T, reason: null };
  } catch {
    return {
      ok: false,
      data: null,
      reason: "`gh` returned output that wasn't valid JSON",
    };
  }
}

export interface GhAuth {
  authenticated: boolean;
  /** The account `gh` is logged in as, when it could be determined. */
  login: string | null;
  reason: string | null;
}

/**
 * Auth preflight, cached in-process for 10 minutes.
 *
 * Cached because every GitHub-backed surface wants to know, and spawning
 * `gh` per card would be slower than the work itself. Not cached longer
 * because `gh auth login` mid-session should start working without a
 * restart.
 */
let authCache: { at: number; value: GhAuth } | null = null;
const AUTH_TTL_MS = 10 * 60 * 1000;

export async function ghAuthStatus(force = false): Promise<GhAuth> {
  const now = Date.now();
  if (!force && authCache && now - authCache.at < AUTH_TTL_MS) {
    return authCache.value;
  }
  // `api user` is a better probe than `auth status`: it proves the token
  // actually works against the API, not just that a token exists.
  const result = await runGhJson<{ login?: string }>([
    "api",
    "user",
    "--jq",
    "{login: .login}",
  ]);
  const value: GhAuth = result.ok
    ? {
        authenticated: true,
        login: result.data?.login ?? null,
        reason: null,
      }
    : { authenticated: false, login: null, reason: result.reason };
  authCache = { at: now, value };
  return value;
}

/** Test seam for the auth cache. */
export function _resetGhAuthCacheForTests(): void {
  authCache = null;
}
