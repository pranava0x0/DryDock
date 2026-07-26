import {
  listBacklog,
  updateBacklogItem,
  type BacklogItem,
} from "../db/backlog";
import { listProjects } from "../db/projects";
import { getSetting, setSetting } from "../db/settings";
import { intakeCapture } from "./intake";
import {
  closeIssue,
  createIssue,
  idFromBody,
  isValidRepo,
  listTrackerIssues,
  refFor,
  renderIssueBody,
  updateIssue,
  type TrackerIssue,
} from "../integrations/github-issues";

/**
 * Backlog ⇄ GitHub tracker sync (EP-13).
 *
 * The Apple Notes sync's conflict rules, generalized. Reading
 * [lib/orchestrator/backlog.ts](backlog.ts) first is worth it — this
 * deliberately mirrors its shape so there's one mental model, not two.
 *
 * ── Structurally simpler than Notes, for one reason ─────────────────────
 * Issue numbers are stable ids. The Notes sync needs a rename heuristic
 * because a note line's identity IS its text, so an edit looks like a
 * delete plus an add. An issue keeps its number through any edit, so
 * renames round-trip with no heuristic at all — which is why this file
 * has no equivalent of `applyPulledLines`' orphan pairing.
 *
 * ── Conflict rules ──────────────────────────────────────────────────────
 * | Situation | Resolution |
 * |---|---|
 * | Accepted in DryDock | push creates the issue, stamps `github_issue_ref` |
 * | Issue opened on GitHub | pull creates a row, **pre-triaged** — opening one is a deliberate act on a deliberate surface |
 * | Done / deleted in DryDock | close the issue (`completed` / `not planned`). Never delete it |
 * | Issue closed on GitHub | DB → `done` |
 * | Issue reopened on GitHub | DB → `idea`. **Bidirectional**, diverging from the Notes irreversible-done rule, because reopening is deliberate, timestamped and logged — none of a checkbox's ambiguity. (Flagged as a product call in the plan §8.) |
 * | Edited on both sides | DB wins on push; a GitHub-side edit pulls straight in by number |
 * | `gh` unavailable | structured error, everything else keeps working |
 *
 * Inbox and `proposed` rows never leave the DB.
 */

export const TRACKER_REPO_KEY = "github_tracker_repo";
export const TRACKER_LAST_SYNC_KEY = "github_tracker_last_sync_at";

export function getTrackerRepo(): string | null {
  const value = getSetting(TRACKER_REPO_KEY);
  return value && isValidRepo(value) ? value : null;
}

export function setTrackerRepo(repo: string | null): void {
  setSetting(TRACKER_REPO_KEY, repo ?? "");
}

export interface MirrorStats {
  repo: string | null;
  created: number;
  updated: number;
  closed: number;
  pulledNew: number;
  pulledUpdated: number;
  /** Rows re-adopted via the body breadcrumb after losing their ref. */
  reAdopted: number;
  status: "ok" | "disabled" | "unavailable";
  reason: string | null;
}

function disabled(reason: string): MirrorStats {
  return {
    repo: null,
    created: 0,
    updated: 0,
    closed: 0,
    pulledNew: 0,
    pulledUpdated: 0,
    reAdopted: 0,
    status: "disabled",
    reason,
  };
}

/**
 * In-process mutex, same rule as the Notes sync: concurrent callers share
 * one run rather than racing two sets of `gh` writes at the same issues.
 */
let inFlight: Promise<MirrorStats> | null = null;

export async function syncGithubMirror(): Promise<MirrorStats> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      return await runMirrorOnce();
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

async function runMirrorOnce(): Promise<MirrorStats> {
  const repo = getTrackerRepo();
  if (!repo) {
    return disabled("no tracker repo configured (Settings → Backlog mirror)");
  }

  const stats: MirrorStats = {
    repo,
    created: 0,
    updated: 0,
    closed: 0,
    pulledNew: 0,
    pulledUpdated: 0,
    reAdopted: 0,
    status: "ok",
    reason: null,
  };

  // Reconcile deletions first. `DELETE /api/backlog/[id]` removes the row
  // and its `github_issue_ref` with it, so a sync that only walks live
  // rows can never find the orphaned issue — it would stay open forever
  // in the "durable" mirror (Codex, PR #8). The delete path leaves a
  // tombstone; this drains it.
  const listed = await listTrackerIssues(repo);
  if (!listed.ok) {
    return { ...stats, status: "unavailable", reason: listed.reason };
  }

  await closeTombstonedIssues(stats);

  const projects = new Map(listProjects().map((p) => [p.id, p.name]));
  // Only the trusted list is mirrored. Inbox and machine proposals stay
  // in the DB — a durable tracker full of unswept captures is a worse
  // artifact than no tracker.
  const items = listBacklog({ stage: "triaged" }).filter(
    (i) => i.status !== "proposed",
  );

  // Pull first, then push — same order as Notes, and for the same
  // reason: an edit made on the far side has to survive the round trip
  // even though the push re-serializes everything.
  await pullFromTracker(items, listed.issues, repo, stats);

  // RE-READ before pushing. `pullFromTracker` writes to SQLite but the
  // `items` array is a snapshot taken before it ran, so a reopened issue
  // would hand the push loop a stale `done` object — which would see an
  // open issue, decide it should be closed, and immediately undo the
  // reopen. The bidirectional-reopen rule was silently a no-op (Codex,
  // PR #8).
  const refreshed = listBacklog({ stage: "triaged" }).filter(
    (i) => i.status !== "proposed",
  );
  await pushToTracker(refreshed, listed.issues, repo, projects, stats);

  // A write failure anywhere in the push means this was NOT a full round.
  // Stamping the success timestamp — and reporting `ok` — would have the
  // Settings panel say "Synced" while issues silently went unwritten.
  if (stats.reason !== null) {
    return { ...stats, status: "unavailable" };
  }

  // Only stamp success after both halves completed, so a partial run
  // leaves an honest older timestamp rather than claiming a full round.
  setSetting(
    TRACKER_LAST_SYNC_KEY,
    String(Math.floor(Date.now() / 1000)),
  );
  return stats;
}

async function pullFromTracker(
  items: BacklogItem[],
  issues: TrackerIssue[],
  repo: string,
  stats: MirrorStats,
): Promise<void> {
  const byRef = new Map(
    items.filter((i) => i.github_issue_ref).map((i) => [i.github_issue_ref!, i]),
  );

  for (const issue of issues) {
    const ref = refFor(repo, issue.number);
    let item = byRef.get(ref) ?? null;

    // Re-adoption: the row lost its ref (a restored DB, a manual edit),
    // but the issue body still carries the breadcrumb. Without this the
    // next push would create a second issue for the same item.
    if (!item) {
      const id = idFromBody(issue.body);
      if (id) {
        const candidate = items.find((i) => i.id === id);
        if (candidate) {
          updateBacklogItem(candidate.id, { github_issue_ref: ref });
          stats.reAdopted += 1;
          item = candidate;
        }
      }
    }

    // An issue opened directly in the tracker: no ref, no breadcrumb.
    // Previously skipped, which meant the advertised pull direction never
    // created anything and `pulledNew` was permanently zero (Codex,
    // PR #8). Route it through the shared intake path so it gets the same
    // parsing and dedup as every other feeder.
    if (!item) {
      if (issue.state === "CLOSED") continue; // don't resurrect old work
      const result = intakeCapture({
        text: issue.title,
        source: "github",
        externalId: `github:${ref}`,
        description: `From ${ref}`,
      });
      if (result.item) {
        updateBacklogItem(result.item.id, {
          github_issue_ref: ref,
          // Opening an issue is a deliberate act on a deliberate
          // surface — same reasoning as an Apple Notes line.
          triaged_at:
            result.item.triaged_at ?? Math.floor(Date.now() / 1000),
        });
        if (result.outcome === "created") stats.pulledNew += 1;
        else stats.pulledUpdated += 1;
      }
      continue;
    }

    if (issue.state === "CLOSED" && item.status !== "done") {
      updateBacklogItem(item.id, { status: "done" });
      stats.pulledUpdated += 1;
    } else if (
      issue.state === "OPEN" &&
      item.status === "done"
    ) {
      // Bidirectional reopen — see the header table for why this diverges
      // from the Notes irreversibility rule.
      updateBacklogItem(item.id, { status: "idea" });
      stats.pulledUpdated += 1;
    }
  }
}

async function pushToTracker(
  items: BacklogItem[],
  issues: TrackerIssue[],
  repo: string,
  projects: Map<string, string>,
  stats: MirrorStats,
): Promise<void> {
  const byNumber = new Map(issues.map((i) => [i.number, i]));

  for (const item of items) {
    const projectName = item.project_id
      ? (projects.get(item.project_id) ?? null)
      : null;
    const body = renderIssueBody({
      id: item.id,
      description: item.description,
      projectName,
      source: item.source,
    });
    const labels = [
      projectName ? `project:${slugLabel(projectName)}` : null,
      `source:${slugLabel(item.source)}`,
    ].filter((l): l is string => l !== null);

    if (!item.github_issue_ref) {
      const created = await createIssue({
        repo,
        title: item.title,
        body,
        labels,
      });
      if (created.ok && created.ref) {
        updateBacklogItem(item.id, { github_issue_ref: created.ref });
        stats.created += 1;
        // A newly created issue is open; if the row is already done,
        // close it in the same pass rather than leaving the tracker
        // showing open work that isn't.
        if (item.status === "done") {
          await closeIssue(created.ref, "completed", "Closed by DryDock.");
          stats.closed += 1;
        }
      } else if (stats.reason === null) {
        stats.reason = created.reason;
      }
      continue;
    }

    const number = Number.parseInt(
      item.github_issue_ref.split("#").pop() ?? "",
      10,
    );
    const issue = Number.isFinite(number) ? byNumber.get(number) : undefined;
    if (!issue) continue;

    // DB wins on push. Only write when something actually differs — an
    // unconditional edit would touch every issue every tick and bury the
    // tracker's own activity feed under sync noise.
    if (issue.title !== item.title || issue.body !== body) {
      const updated = await updateIssue(item.github_issue_ref, {
        title: item.title,
        body,
      });
      if (updated.ok) stats.updated += 1;
      else if (stats.reason === null) stats.reason = updated.reason;
    }

    const shouldBeClosed = item.status === "done" || item.status === "dropped";
    if (shouldBeClosed && issue.state === "OPEN") {
      const closed = await closeIssue(
        item.github_issue_ref,
        item.status === "done" ? "completed" : "not planned",
        `Closed by DryDock (${item.status}).`,
      );
      if (closed.ok) stats.closed += 1;
      else if (stats.reason === null) stats.reason = closed.reason;
    }
  }
}

/** GitHub labels can't contain spaces comfortably; keep them terse. */
/**
 * Tombstones for deleted items whose issue is still open.
 *
 * Stored in `settings` as a JSON array rather than a table: it is a
 * transient queue that is normally empty, and a table would be a schema
 * change plus a migration for something that holds at most a handful of
 * refs between two syncs.
 */
export const TOMBSTONE_KEY = "github_tracker_pending_closes";

export function readTombstones(): string[] {
  const raw = getSetting(TOMBSTONE_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((r): r is string => typeof r === "string")
      : [];
  } catch {
    return [];
  }
}

/** Record that a deleted item's issue still needs closing. */
export function addTombstone(ref: string): void {
  if (!ref) return;
  const existing = readTombstones();
  if (existing.includes(ref)) return;
  setSetting(TOMBSTONE_KEY, JSON.stringify([...existing, ref]));
}

async function closeTombstonedIssues(stats: MirrorStats): Promise<void> {
  const pending = readTombstones();
  if (pending.length === 0) return;
  const stillPending: string[] = [];
  for (const ref of pending) {
    const closed = await closeIssue(
      ref,
      "not planned",
      "Closed by DryDock (item deleted).",
    );
    if (closed.ok) stats.closed += 1;
    else {
      // Keep it queued — an offline `gh` shouldn't lose the intent.
      stillPending.push(ref);
      if (stats.reason === null) stats.reason = closed.reason;
    }
  }
  setSetting(TOMBSTONE_KEY, JSON.stringify(stillPending));
}

export function slugLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}
