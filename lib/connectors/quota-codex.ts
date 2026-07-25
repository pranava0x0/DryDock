import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { QuotaWindow } from "../db/quota";

/**
 * Codex live quota via the CLI's own `app-server` (EP-10 Spec D).
 *
 * ── Why a subprocess and not an HTTP call ───────────────────────────────
 * The percentage the caps actually gate on is not derivable from token
 * sums: OpenAI doesn't publish the denominator and weights by reasoning
 * effort. `codex app-server` is the sanctioned local surface for it — a
 * JSON-RPC server over stdio that rides the CLI's own `~/.codex/auth.json`
 * OAuth session. That means **no credentials touch DryDock**, which is
 * the same reason the dispatcher shells out to `claude` rather than
 * calling an API. It is also the interface OpenAI's own editor extension
 * uses, so it's a supported path rather than a reverse-engineered one.
 *
 * The rollout JSONLs cannot substitute: their `rate_limits` field is
 * confirmed always-null (openai/codex#14880).
 *
 * ── Verified state on this machine ──────────────────────────────────────
 * `codex` is NOT on PATH here — this user drives Codex through the
 * desktop app and the VS Code extension (`originator: "Codex Desktop"`,
 * `source: "vscode"` in the rollout metadata). So this collector reports
 * `unavailable` today and the Usage tab falls back to the manual /
 * deep-link path. That's the designed degradation, not a failure: install
 * the CLI and it starts working with no code change. Everything below is
 * written against the documented protocol and exercised by fixtures
 * rather than against a live server.
 */

export interface CodexRateLimitWindow {
  window: QuotaWindow;
  usedPct: number | null;
  resetsAt: number | null;
  windowMinutes: number | null;
}

export interface CodexQuotaResult {
  status: "ok" | "unavailable";
  reason: string | null;
  windows: CodexRateLimitWindow[];
  planType: string | null;
  creditsBalance: number | null;
}

/** Short: this runs on a dashboard read, behind a TTL. */
const DEFAULT_TIMEOUT_MS = 8000;

function unavailable(reason: string): CodexQuotaResult {
  return {
    status: "unavailable",
    reason,
    windows: [],
    planType: null,
    creditsBalance: null,
  };
}

export interface CodexQuotaOptions {
  command?: string;
  args?: readonly string[];
  timeoutMs?: number;
}

/**
 * Ask the app-server for the current rate-limit state.
 *
 * Never throws: every failure mode — CLI absent, not authenticated,
 * protocol drift, timeout — becomes an `unavailable` result with a
 * reason, because the UI must render "we can't tell you" rather than a
 * fabricated 0%.
 */
export async function readCodexQuota(
  options: CodexQuotaOptions = {},
): Promise<CodexQuotaResult> {
  const command = options.command ?? "codex";
  const args = options.args ?? ["app-server"];
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(command, args, {
      // Inherit the environment so the server finds ~/.codex/auth.json,
      // exactly like the dispatcher does for `claude`. No secrets added.
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    return unavailable(`could not start \`${command} app-server\`: ${(err as Error).message}`);
  }

  return new Promise<CodexQuotaResult>((resolve) => {
    let settled = false;
    const stderr: string[] = [];

    const finish = (result: CodexQuotaResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGTERM");
      } catch {
        // Already gone.
      }
      resolve(result);
    };

    const timer = setTimeout(
      () =>
        finish(
          unavailable(
            `\`${command} app-server\` did not answer within ${timeoutMs}ms`,
          ),
        ),
      timeoutMs,
    );
    timer.unref?.();

    child.on("error", (err) =>
      finish(
        unavailable(
          // The overwhelmingly common case, and worth naming precisely:
          // the CLI isn't installed. Saying "not installed" beats
          // "ENOENT" in a health chip.
          err.message.includes("ENOENT")
            ? `the \`${command}\` CLI is not installed or not on PATH`
            : `\`${command} app-server\` failed to start: ${err.message}`,
        ),
      ),
    );

    child.on("exit", (code) => {
      const tail = stderr.slice(-3).join(" ").trim();
      finish(
        unavailable(
          `\`${command} app-server\` exited (${code})${tail ? `: ${tail}` : ""}`,
        ),
      );
    });

    if (child.stderr) {
      const rl = createInterface({ input: child.stderr });
      rl.on("line", (line) => stderr.push(line));
    }

    if (child.stdout) {
      const rl = createInterface({ input: child.stdout });
      rl.on("line", (line) => {
        const parsed = safeParse(line);
        if (!parsed) return;
        // Only the response to our own request id matters; notifications
        // and the initialize reply are ignored.
        if (parsed.id !== RATE_LIMIT_ID) return;
        if (isPlainObject(parsed.error)) {
          const message =
            typeof parsed.error.message === "string"
              ? parsed.error.message
              : "unknown error";
          finish(unavailable(`app-server refused the request: ${message}`));
          return;
        }
        finish(parseRateLimits(parsed.result));
      });
    }

    if (!child.stdin) {
      finish(unavailable("app-server exposed no stdin to write JSON-RPC to"));
      return;
    }
    // Initialize first — the server rejects requests before the
    // handshake — then ask for the rate limits.
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: INIT_ID,
        method: "initialize",
        params: {
          clientInfo: { name: "drydock", title: "DryDock", version: "0.1.0" },
        },
      })}\n`,
    );
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: RATE_LIMIT_ID,
        method: "account/rateLimits/read",
        params: {},
      })}\n`,
    );
  });
}

const INIT_ID = 1;
const RATE_LIMIT_ID = 2;

/**
 * Map the app-server's rate-limit payload onto quota windows.
 *
 * Deliberately tolerant: field names are read defensively and anything
 * missing stays null rather than defaulting to a number. A schema change
 * upstream should cost us a blank, not a wrong percentage.
 */
export function parseRateLimits(result: unknown): CodexQuotaResult {
  if (!isPlainObject(result)) {
    return unavailable("app-server returned an unrecognized payload");
  }
  const source = isPlainObject(result.rateLimits) ? result.rateLimits : result;
  const windows: CodexRateLimitWindow[] = [];

  const primary = isPlainObject(source.primary) ? source.primary : null;
  const secondary = isPlainObject(source.secondary) ? source.secondary : null;
  if (primary) windows.push(readWindow("5h", primary));
  if (secondary) windows.push(readWindow("week", secondary));

  if (windows.length === 0) {
    return unavailable(
      "app-server answered but reported no rate-limit windows",
    );
  }

  const credits = isPlainObject(source.credits) ? source.credits : null;
  return {
    status: "ok",
    reason: null,
    windows,
    planType: typeof source.planType === "string" ? source.planType : null,
    creditsBalance: numOrNull(credits?.balance),
  };
}

function readWindow(
  window: QuotaWindow,
  raw: Record<string, unknown>,
): CodexRateLimitWindow {
  const resets = numOrNull(raw.resetsAt);
  return {
    window,
    usedPct: numOrNull(raw.usedPercent),
    // The server may report either epoch seconds or milliseconds; 1e11
    // seconds is the year 5138, so magnitude disambiguates safely.
    resetsAt:
      resets === null ? null : resets > 100_000_000_000 ? Math.floor(resets / 1000) : resets,
    windowMinutes: numOrNull(raw.windowDurationMins),
  };
}

function safeParse(line: string): Record<string, unknown> | null {
  if (line.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(line);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
