import {
  createBacklogItem,
  deleteBacklogItem,
  getBacklogItem,
  getBacklogItemByExternalId,
  getBacklogItemByTitle,
  listBacklog,
  updateBacklogItem,
  type BacklogItem,
  type BacklogStatus,
} from "../db/backlog";
import { createTask } from "../db/tasks";
import { getProject, listProjects } from "../db/projects";
import { getNumberSetting, getSetting, setSetting } from "../db/settings";
import {
  DEFAULT_NOTE_TITLE,
  parseAppleNote,
  readAppleNote,
  renderAppleNoteBody,
  writeAppleNote,
  type AppleNoteLine,
} from "../integrations/apple-notes";

export const NOTES_TITLE_KEY = "apple_notes_title";
/**
 * Stable Apple Notes id of the canonical DryDock note (`x-coredata://
 * <accountUUID>/ICNote/p<n>`). Persisted after the first successful
 * write so subsequent syncs can target that exact note rather than
 * leaving the choice to AppleScript's non-deterministic by-name
 * enumeration — which is what made it look like duplicates were still
 * being created post-V3. Cleared when the stored id no longer resolves
 * (note manually deleted, account removed).
 */
export const NOTES_NOTE_ID_KEY = "apple_notes_note_id";
/**
 * Unix-seconds timestamp of the last successful sync (read + write
 * both completed without throwing). Used by the UI to show "Synced
 * 30s ago" and by the client-side auto-sync hook to throttle.
 */
export const NOTES_LAST_SYNC_KEY = "apple_notes_last_sync_at";

/**
 * In-process mutex. When a sync is in flight, concurrent callers
 * (e.g. the /backlog polling timer firing while a manual "Sync Notes"
 * click is mid-osascript) share the same promise rather than racing
 * to launch a second AppleScript and stepping on each other's writes.
 * Cleared in finally so a failed sync doesn't permanently block.
 */
let inFlightSync: Promise<SyncStats> | null = null;

/**
 * One-time migration: prior versions stored the title as
 * "DryDock Backlog" (without the anchor emoji). Apple Notes derives the
 * note's `name` from the first line of the body — which is
 * "⚓ DryDock Backlog" — so the by-name search against the old stored
 * value never matched anything and the fallback path kept creating new
 * notes. Upgrade in place so the search lines up with what's actually
 * in iCloud.
 */
const OLD_TITLE_NO_ANCHOR = "DryDock Backlog";

export function getNotesTitle(): string {
  const stored = getSetting(NOTES_TITLE_KEY);
  if (stored === null) return DEFAULT_NOTE_TITLE;
  if (stored === OLD_TITLE_NO_ANCHOR) {
    setSetting(NOTES_TITLE_KEY, DEFAULT_NOTE_TITLE);
    return DEFAULT_NOTE_TITLE;
  }
  return stored;
}

export function setNotesTitle(title: string): void {
  setSetting(NOTES_TITLE_KEY, title);
}

/**
 * Last successful sync time as Unix seconds, or null if we've never
 * synced. Used by the UI's SyncStatus badge and the auto-sync hook.
 */
export function getLastSyncedAt(): number | null {
  return getNumberSetting(NOTES_LAST_SYNC_KEY);
}

function recordSyncedAt(now: number = Math.floor(Date.now() / 1000)): void {
  setSetting(NOTES_LAST_SYNC_KEY, String(now));
}

export function getNotesNoteId(): string | null {
  return getSetting(NOTES_NOTE_ID_KEY);
}

export function setNotesNoteId(id: string | null): void {
  if (id === null || id.length === 0) {
    setSetting(NOTES_NOTE_ID_KEY, "");
  } else {
    setSetting(NOTES_NOTE_ID_KEY, id);
  }
}

export class BurnDownError extends Error {
  constructor(
    message: string,
    public readonly code: "item_not_found" | "project_required" | "project_not_found",
  ) {
    super(message);
    this.name = "BurnDownError";
  }
}

/**
 * "Burn down" a backlog item: create a Task in the linked project and
 * mark the item in_progress with a pointer to the task. The orchestrator
 * doesn't auto-dispatch — the user still has to click Run on the task.
 *
 * Why not auto-dispatch: agents can mutate worktrees, and a burndown is a
 * decision moment. Inserting a Pending task gives the user a chance to
 * edit the description before paying for tokens.
 */
export function burnDownBacklogItem(
  itemId: string,
  overrideProjectId?: string | null,
): { taskId: string; backlogId: string } {
  const item = getBacklogItem(itemId);
  if (!item) {
    throw new BurnDownError(`Backlog item not found: ${itemId}`, "item_not_found");
  }
  const projectId = overrideProjectId ?? item.project_id;
  if (!projectId) {
    throw new BurnDownError(
      "Backlog item has no project. Pass overrideProjectId or set project_id on the item first.",
      "project_required",
    );
  }
  const project = getProject(projectId);
  if (!project) {
    throw new BurnDownError(
      `Project not found: ${projectId}`,
      "project_not_found",
    );
  }

  const task = createTask({
    project_id: project.id,
    title: item.title,
    description: item.description ?? item.title,
    provider: project.provider,
  });

  updateBacklogItem(item.id, {
    status: "in_progress",
    project_id: project.id,
    task_id: task.id,
  });

  return { taskId: task.id, backlogId: item.id };
}

export interface SyncStats {
  notesTitle: string;
  pulledNew: number;
  pulledUpdated: number;
  pushedItems: number;
}

/**
 * Bidirectional Apple Notes sync.
 *
 * Pull phase: read the note, parse each line, upsert into the DB. Items
 * whose checkbox is checked move to `done`; items unchecked but already
 * marked done in the DB stay done (user can't accidentally re-open a
 * completed item from the note).
 *
 * Push phase: render the current DB state back to the note. Items in
 * status='dropped' are excluded so the note stays focused on actionable
 * work.
 *
 * Pull-then-push is the right order: it ensures any edits the user made
 * in Apple Notes survive the round-trip even though the push will
 * re-serialize everything.
 *
 * **Conflict resolution rules** (deliberate, documented for future me):
 *
 *   - **Add in Notes, not in DB**: pull creates the row.
 *   - **Add in DB, not in Notes**: push writes the line. Manual rows
 *     carry external_id = lineId(title) from POST so a future pull
 *     finds them and doesn't mint a duplicate.
 *   - **Same item, both sides**: same line key → same row, no-op.
 *   - **Checked off in Notes**: row promoted to `done`. Irreversible —
 *     un-checking in Notes does *not* re-open. (Closes the loop; the
 *     user can re-add the item explicitly via UI if needed.)
 *   - **Done in UI**: rendered as `[x]` in the note.
 *   - **Dropped in UI**: excluded from the next push, so it disappears
 *     from the note. The DB row stays so a history view could surface
 *     it later.
 *   - **Line removed from Notes**: ignored — re-added on the next
 *     push. Notes deletion is one-tap and hard to undo; we don't let
 *     it nuke backlog state. To actually remove an item, use the UI.
 *   - **Rename in UI**: title changes; the next pull's by-external_id
 *     lookup misses (external_id stayed the same, but the rendered
 *     line's text changed → its lineId differs), then the by-title
 *     fallback finds the renamed row and re-claims it with the new
 *     external_id. Round-trips cleanly.
 *   - **Rename in Notes**: detected when the pull has exactly one
 *     deferred-as-new line AND exactly one apple-notes-sourced DB row
 *     whose external_id just disappeared from the note. The pair is
 *     treated as a rename — title + external_id updated in place. If
 *     the user renamed *and* added in the same window (>1 deferred or
 *     >1 orphan), we fall back to treating new lines as creates so
 *     we don't pair the wrong items together. See `applyPulledLines`.
 *
 * Wrapped in an in-process mutex (`inFlightSync`) so two concurrent
 * callers (e.g. the /backlog polling timer firing while the user hits
 * "Sync Notes") share a single AppleScript invocation rather than
 * racing.
 */
export async function syncWithAppleNotes(): Promise<SyncStats> {
  if (inFlightSync) return inFlightSync;
  inFlightSync = (async () => {
    try {
      return await runSyncOnce();
    } finally {
      inFlightSync = null;
    }
  })();
  return inFlightSync;
}

/**
 * Apply a parsed Apple-Notes pull to the DB. Extracted from
 * runSyncOnce so the rename heuristic + the existing fast-paths can be
 * unit-tested without shelling out to osascript.
 *
 * Per-line resolution order:
 *   1. **by external_id**: same line key from a prior sync. Update
 *      status if the user just checked the box.
 *   2. **by title (null external_id)**: claim a pre-existing manual
 *      row that hasn't been stamped yet. Promotes source and stamps
 *      external_id so the by-external_id path catches it next time.
 *   3. **defer**: collect lines that didn't match either fast-path.
 *
 * Post-loop, the deferred-creates pass is preceded by a
 * **rename heuristic**: if exactly one DB row is now an "orphan"
 * (apple-notes-sourced, non-terminal status, has an external_id that
 * isn't in the current pull) AND exactly one deferred line exists,
 * treat the pair as a rename in place. This catches the common case
 * of the user typing a fix into the Notes app between syncs without
 * inadvertently duplicating the row.
 *
 * Multi-edit windows (n orphans, m deferred, n+m > 2) skip the
 * rename — too ambiguous to pair safely. Those lines become genuinely
 * new rows; the orphans stay (and get re-pushed on the next round
 * per the "delete-in-Notes is ignored" rule).
 */
export function applyPulledLines(
  lines: AppleNoteLine[],
): { pulledNew: number; pulledUpdated: number } {
  let pulledNew = 0;
  let pulledUpdated = 0;
  const deferredCreates: AppleNoteLine[] = [];

  for (const line of lines) {
    const existing = getBacklogItemByExternalId(line.externalId);
    if (existing) {
      // Checked off in Notes → promote DB to done (irreversible —
      // un-checking in Notes does NOT re-open).
      if (line.done && existing.status !== "done") {
        updateBacklogItem(existing.id, { status: "done" });
        pulledUpdated += 1;
      }
      continue;
    }
    // Title-claim: a pre-existing manual row with no external_id yet
    // (created before POST started stamping lineId). Promote it in
    // place rather than minting a duplicate.
    const sameTitle = getBacklogItemByTitle(line.text);
    if (sameTitle && sameTitle.external_id === null) {
      updateBacklogItem(sameTitle.id, {
        external_id: line.externalId,
        source: "apple-notes",
        ...(line.done && sameTitle.status !== "done"
          ? { status: "done" }
          : {}),
      });
      pulledUpdated += 1;
      continue;
    }
    deferredCreates.push(line);
  }

  // Rename heuristic — only applies when the pull is unambiguous.
  // We look for rows that *used to* be in the note (external_id not
  // in the current pull's id set) and are still actionable
  // (idea / in_progress). A 1:1 orphan/deferred pair is treated as
  // a rename: update the row's title + external_id in place.
  const currentExternalIds = new Set(lines.map((l) => l.externalId));
  const orphans = listBacklog().filter(
    (i) =>
      i.source === "apple-notes" &&
      i.external_id !== null &&
      !currentExternalIds.has(i.external_id) &&
      (i.status === "idea" || i.status === "in_progress"),
  );
  if (orphans.length === 1 && deferredCreates.length === 1) {
    const orphan = orphans[0];
    const newLine = deferredCreates[0];
    updateBacklogItem(orphan.id, {
      title: newLine.text,
      external_id: newLine.externalId,
      ...(newLine.done && orphan.status !== "done"
        ? { status: "done" }
        : {}),
    });
    pulledUpdated += 1;
    return { pulledNew, pulledUpdated };
  }

  // No rename match → every deferred line becomes a fresh row.
  for (const line of deferredCreates) {
    createBacklogItem({
      title: line.text,
      source: "apple-notes",
      external_id: line.externalId,
      status: line.done ? "done" : "idea",
      // Preserve the `· added YYYY-MM-DD` date so a DB rebuild from
      // the note doesn't reset every item's history to "today."
      ...(line.createdAt !== null ? { created_at: line.createdAt } : {}),
    });
    pulledNew += 1;
  }

  return { pulledNew, pulledUpdated };
}

async function runSyncOnce(): Promise<SyncStats> {
  const title = getNotesTitle();
  // Stable id stored from the last successful write. Lets the script
  // hit `note id "..."` directly instead of relying on AppleScript's
  // by-name enumeration, which is what caused the "looks like new
  // notes on every sync" behavior — different writable duplicates
  // kept rising to the top of the sidebar.
  const storedNoteId = getNotesNoteId();
  let pulledNew = 0;
  let pulledUpdated = 0;

  const body = await readAppleNote(title, storedNoteId);
  if (body !== null) {
    const lines = parseAppleNote(body);
    const { pulledNew: newCount, pulledUpdated: updatedCount } =
      applyPulledLines(lines);
    pulledNew = newCount;
    pulledUpdated = updatedCount;
  }

  // Push: render every visible item back to the note. We deliberately
  // include "done" items (with a checkmark) so the user has visibility
  // into recently-completed work in the note. "dropped" items are
  // excluded — they represent ideas the user actively dismissed.
  const items = listBacklog();
  const renderable = items
    .filter((i) => i.status !== "dropped")
    .map((i) => ({
      title: i.title,
      status: i.status,
      createdAt: i.created_at,
    }));
  const writtenId = await writeAppleNote(
    title,
    renderAppleNoteBody(renderable, title),
    storedNoteId,
  );
  // Persist the id that the script actually used. On the first sync
  // after install (or after the user deletes the stored note) this is
  // the id of the writable match the script picked or the one it
  // freshly created — locking subsequent syncs onto that exact note.
  if (writtenId && writtenId !== storedNoteId) {
    setNotesNoteId(writtenId);
  }

  // Only mark the sync successful here, after both the read and the
  // write completed without throwing. A partial failure (e.g. read OK
  // but write blocked by permissions) deliberately leaves the
  // timestamp unchanged so the UI keeps showing the older "Synced
  // <when>" value rather than misreporting a half-finished round.
  recordSyncedAt();

  return {
    notesTitle: title,
    pulledNew,
    pulledUpdated,
    pushedItems: renderable.length,
  };
}

/**
 * Push-only variant — used after every mutation in the API so the note
 * stays current without forcing a full sync. Errors are caught and
 * returned rather than thrown so a mutation isn't blocked by Apple
 * Notes auth issues.
 */
export async function pushToAppleNotesSilently(): Promise<{ ok: boolean; error?: string }> {
  try {
    const title = getNotesTitle();
    const storedNoteId = getNotesNoteId();
    const items = listBacklog();
    const renderable = items
      .filter((i) => i.status !== "dropped")
      .map((i) => ({
        title: i.title,
        status: i.status,
        createdAt: i.created_at,
      }));
    const writtenId = await writeAppleNote(
      title,
      renderAppleNoteBody(renderable, title),
      storedNoteId,
    );
    if (writtenId && writtenId !== storedNoteId) {
      setNotesNoteId(writtenId);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Status priority for dedupe merging. Higher = more "load-bearing":
 *
 *   - done: user explicitly completed it
 *   - in_progress: there's a real task hanging off it
 *   - idea: default state, lowest signal
 *   - dropped: user explicitly dismissed it
 *
 * When duplicates exist, the merged row keeps the status with the
 * highest score so a "done" copy doesn't get resurrected as "idea".
 */
const STATUS_RANK: Record<BacklogStatus, number> = {
  done: 3,
  in_progress: 2,
  idea: 1,
  dropped: 0,
};

export interface DedupeReport {
  /** Total rows removed across all groups. */
  removed: number;
  /** Number of duplicate groups collapsed (each had ≥2 members). */
  groupsMerged: number;
  /** Ids that were deleted, in case the caller wants to surface them. */
  deletedIds: string[];
}

/**
 * Collapse same-title duplicates in the backlog. Same trimmed,
 * case-folded title = same logical item, even if one came from a
 * manual entry and the other from Apple Notes (or two manuals got
 * typed twice).
 *
 * Keeper selection:
 *   1. Prefer the apple-notes-sourced row (has a stable external_id
 *      so a future re-sync finds it without minting a new row).
 *   2. Within the same source, prefer the oldest created_at — the
 *      original is the "real" item; later duplicates are noise.
 *
 * Field merging onto the keeper:
 *   - status: highest STATUS_RANK across the group (so a "done" copy
 *     doesn't get demoted back to "idea")
 *   - project_id, task_id: first non-null wins (no clobber of an
 *     intentional assignment with a null from a stray duplicate)
 *
 * Duplicates are then `deleteBacklogItem`'d. The Apple Notes push that
 * follows will reflect the consolidated DB.
 */
export function dedupeBacklogItems(): DedupeReport {
  const all = listBacklog();
  const groups = new Map<string, BacklogItem[]>();
  for (const item of all) {
    const key = item.title.trim().toLowerCase();
    if (!key) continue;
    const bucket = groups.get(key) ?? [];
    bucket.push(item);
    groups.set(key, bucket);
  }

  const report: DedupeReport = { removed: 0, groupsMerged: 0, deletedIds: [] };
  for (const bucket of groups.values()) {
    if (bucket.length < 2) continue;
    bucket.sort((a, b) => {
      if (a.source !== b.source) {
        return a.source === "apple-notes" ? -1 : 1;
      }
      return a.created_at - b.created_at;
    });
    const keeper = bucket[0];
    const dupes = bucket.slice(1);

    let bestStatus: BacklogStatus = keeper.status;
    let bestProject = keeper.project_id;
    let bestTaskId = keeper.task_id;
    for (const d of dupes) {
      if (STATUS_RANK[d.status] > STATUS_RANK[bestStatus]) {
        bestStatus = d.status;
      }
      if (bestProject === null && d.project_id !== null) bestProject = d.project_id;
      if (bestTaskId === null && d.task_id !== null) bestTaskId = d.task_id;
    }

    updateBacklogItem(keeper.id, {
      status: bestStatus,
      project_id: bestProject,
      task_id: bestTaskId,
    });
    for (const d of dupes) {
      deleteBacklogItem(d.id);
      report.deletedIds.push(d.id);
      report.removed += 1;
    }
    report.groupsMerged += 1;
  }
  return report;
}

/**
 * Cross-project helper for the dashboard: returns the count of pending
 * backlog items grouped by project (or "unassigned"). Used to power a
 * "Backlog: 12 ideas / 3 in progress" header chip.
 */
export interface BacklogSummary {
  total: number;
  idea: number;
  in_progress: number;
  done: number;
  byProject: Array<{
    projectId: string | null;
    projectName: string | null;
    count: number;
  }>;
}

export function backlogSummary(): BacklogSummary {
  const items = listBacklog();
  const projects = new Map(listProjects().map((p) => [p.id, p.name]));
  const summary: BacklogSummary = {
    total: items.length,
    idea: 0,
    in_progress: 0,
    done: 0,
    byProject: [],
  };
  const counts = new Map<string | null, number>();
  for (const item of items) {
    if (item.status === "idea") summary.idea += 1;
    else if (item.status === "in_progress") summary.in_progress += 1;
    else if (item.status === "done") summary.done += 1;
    counts.set(item.project_id, (counts.get(item.project_id) ?? 0) + 1);
  }
  for (const [projectId, count] of counts) {
    summary.byProject.push({
      projectId,
      projectName: projectId ? (projects.get(projectId) ?? null) : null,
      count,
    });
  }
  return summary;
}
