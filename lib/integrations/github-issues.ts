import { runGh, runGhJson } from "./gh";
import { ghAuthStatus } from "./gh";

/**
 * The GitHub Issues spoke (EP-13 Spec A) — the push half.
 *
 * ── Topology: hub-and-spoke, one tracker repo ───────────────────────────
 * SQLite stays the hub, exactly as it is for Apple Notes. **One private
 * tracker repo** holds one issue per *triaged* backlog item. Per-project
 * repos are deliberately not used: cross-project prioritisation is the
 * whole point of a global backlog, and scattering it across a dozen
 * trackers would make "what should I do next" unanswerable.
 *
 * Inbox and `proposed` rows never leave the DB. The durable tracker
 * mirrors the list the user trusts, not the feed of raw captures.
 *
 * ── Open/closed IS the status ───────────────────────────────────────────
 * No status labels. A second representation of state is a second thing
 * that can disagree with the first, and the Apple Notes work already
 * taught this codebase what that costs. Labels carry only `project:` and
 * `source:`, which are facts rather than state.
 *
 * ── Closing, never deleting ─────────────────────────────────────────────
 * A DryDock delete closes the issue with a comment; it never deletes it.
 * That's the durable analogue of the existing "DELETE is DB-only" rule —
 * the point of a durable mirror is that it survives things, including
 * mistakes.
 *
 * No tokens: everything goes through the `gh` CLI, which holds the user's
 * own credential.
 */

/** The recovery breadcrumb — the Probot metadata pattern. */
export function breadcrumb(id: string): string {
  return `<!-- drydock:id:${id} -->`;
}

const BREADCRUMB = /<!--\s*drydock:id:([A-Za-z0-9_-]+)\s*-->/;

/** Recover a DryDock id from an issue body whose stamped ref was lost. */
export function idFromBody(body: string): string | null {
  const match = typeof body === "string" ? body.match(BREADCRUMB) : null;
  return match ? match[1] : null;
}

/** `owner/repo#42`. */
export function refFor(repo: string, number: number): string {
  return `${repo}#${number}`;
}

export function parseRef(
  ref: string,
): { repo: string; number: number } | null {
  const match = typeof ref === "string" ? ref.match(/^(.+)#(\d+)$/) : null;
  if (!match) return null;
  const number = Number.parseInt(match[2], 10);
  return Number.isFinite(number) ? { repo: match[1], number } : null;
}

/**
 * A tracker repo name must be `owner/name`. Validated rather than
 * trusted: it's user-entered and goes straight into an argv array, and a
 * typo should be a clear error rather than a confusing `gh` failure.
 */
export function isValidRepo(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(value)
  );
}

export interface IssueBodyInput {
  id: string;
  description: string | null;
  projectName: string | null;
  source: string;
}

/**
 * Issue body: the description, then the breadcrumb.
 *
 * The breadcrumb is last and HTML-commented so it's invisible in
 * GitHub's rendering but recoverable by a plain-text search — that's
 * what lets a row whose `github_issue_ref` was lost be re-adopted
 * instead of duplicated.
 */
export function renderIssueBody(input: IssueBodyInput): string {
  const parts: string[] = [];
  if (input.description && input.description.trim().length > 0) {
    parts.push(input.description.trim());
  }
  parts.push(
    [
      "---",
      `Tracked by DryDock${input.projectName ? ` · project: ${input.projectName}` : ""} · source: ${input.source}`,
      breadcrumb(input.id),
    ].join("\n"),
  );
  return parts.join("\n\n");
}

export interface PushIssueInput {
  repo: string;
  title: string;
  body: string;
  labels: string[];
}

export interface PushResult {
  ok: boolean;
  ref: string | null;
  reason: string | null;
}

/**
 * Create an issue and return its `owner/repo#n` ref.
 *
 * `gh issue create` prints the issue URL on success; the number is
 * parsed back out of it, because `gh issue create` has no `--json`.
 */
export async function createIssue(
  input: PushIssueInput,
): Promise<PushResult> {
  if (!isValidRepo(input.repo)) {
    return { ok: false, ref: null, reason: `invalid tracker repo: ${input.repo}` };
  }
  const args = [
    "issue",
    "create",
    "--repo",
    input.repo,
    "--title",
    input.title,
    "--body",
    input.body,
  ];
  for (const label of input.labels) {
    args.push("--label", label);
  }
  const result = await runGh(args);
  if (!result.ok) return { ok: false, ref: null, reason: result.reason };

  const number = issueNumberFromUrl(result.stdout);
  if (number === null) {
    return {
      ok: false,
      ref: null,
      reason: "created the issue but could not parse its number from gh's output",
    };
  }
  return { ok: true, ref: refFor(input.repo, number), reason: null };
}

export function issueNumberFromUrl(output: string): number | null {
  const match = typeof output === "string" ? output.match(/\/issues\/(\d+)/) : null;
  if (!match) return null;
  const number = Number.parseInt(match[1], 10);
  return Number.isFinite(number) ? number : null;
}

export async function updateIssue(
  ref: string,
  fields: { title?: string; body?: string },
): Promise<PushResult> {
  const parsed = parseRef(ref);
  if (!parsed) return { ok: false, ref: null, reason: `invalid ref: ${ref}` };
  const args = [
    "issue",
    "edit",
    String(parsed.number),
    "--repo",
    parsed.repo,
  ];
  if (fields.title !== undefined) args.push("--title", fields.title);
  if (fields.body !== undefined) args.push("--body", fields.body);
  if (args.length === 5) return { ok: true, ref, reason: null };

  const result = await runGh(args);
  return result.ok
    ? { ok: true, ref, reason: null }
    : { ok: false, ref, reason: result.reason };
}

/**
 * Close an issue. `completed` for a done item, `not planned` for a
 * dropped or deleted one — GitHub renders those differently, and the
 * distinction is exactly what makes the tracker readable a year later.
 */
export async function closeIssue(
  ref: string,
  reason: "completed" | "not planned",
  comment?: string,
): Promise<PushResult> {
  const parsed = parseRef(ref);
  if (!parsed) return { ok: false, ref: null, reason: `invalid ref: ${ref}` };
  const args = [
    "issue",
    "close",
    String(parsed.number),
    "--repo",
    parsed.repo,
    "--reason",
    reason,
  ];
  if (comment) args.push("--comment", comment);
  const result = await runGh(args);
  return result.ok
    ? { ok: true, ref, reason: null }
    : { ok: false, ref, reason: result.reason };
}

export async function reopenIssue(ref: string): Promise<PushResult> {
  const parsed = parseRef(ref);
  if (!parsed) return { ok: false, ref: null, reason: `invalid ref: ${ref}` };
  const result = await runGh([
    "issue",
    "reopen",
    String(parsed.number),
    "--repo",
    parsed.repo,
  ]);
  return result.ok
    ? { ok: true, ref, reason: null }
    : { ok: false, ref, reason: result.reason };
}

export interface TrackerIssue {
  number: number;
  title: string;
  body: string;
  state: "OPEN" | "CLOSED";
  labels: string[];
  updatedAt: string;
}

interface RawTrackerIssue {
  number?: number;
  title?: string;
  body?: string;
  state?: string;
  labels?: Array<{ name?: string }>;
  updatedAt?: string;
}

/**
 * Every issue in the tracker, open and closed.
 *
 * Closed ones matter: that's how a "done on GitHub" state gets pulled
 * back, and how a re-push knows not to recreate something that already
 * exists in closed form.
 */
export async function listTrackerIssues(
  repo: string,
  limit = 200,
): Promise<{ ok: boolean; issues: TrackerIssue[]; reason: string | null }> {
  if (!isValidRepo(repo)) {
    return { ok: false, issues: [], reason: `invalid tracker repo: ${repo}` };
  }
  const result = await runGhJson<RawTrackerIssue[]>([
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    "all",
    "--limit",
    String(limit),
    "--json",
    "number,title,body,state,labels,updatedAt",
  ]);
  if (!result.ok) return { ok: false, issues: [], reason: result.reason };

  const issues = (result.data ?? [])
    .map((raw): TrackerIssue | null => {
      if (typeof raw.number !== "number") return null;
      return {
        number: raw.number,
        title: raw.title ?? "",
        body: raw.body ?? "",
        state: raw.state === "CLOSED" ? "CLOSED" : "OPEN",
        labels: (raw.labels ?? [])
          .map((l) => l.name)
          .filter((n): n is string => typeof n === "string"),
        updatedAt: raw.updatedAt ?? "",
      };
    })
    .filter((i): i is TrackerIssue => i !== null);
  return { ok: true, issues, reason: null };
}

/** Create the tracker repo. Private by default — it's a personal backlog. */
export async function createTrackerRepo(
  repo: string,
): Promise<{ ok: boolean; reason: string | null }> {
  if (!isValidRepo(repo)) {
    return { ok: false, reason: `invalid tracker repo: ${repo}` };
  }
  const auth = await ghAuthStatus();
  if (!auth.authenticated) {
    return { ok: false, reason: auth.reason ?? "`gh` is not authenticated" };
  }
  const result = await runGh([
    "repo",
    "create",
    repo,
    "--private",
    "--description",
    "DryDock backlog mirror",
  ]);
  return result.ok
    ? { ok: true, reason: null }
    : { ok: false, reason: result.reason };
}
