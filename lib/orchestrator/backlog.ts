import {
  createBacklogItem,
  getBacklogItem,
  getBacklogItemByExternalId,
  listBacklog,
  updateBacklogItem,
} from "../db/backlog";
import { createTask } from "../db/tasks";
import { getProject, listProjects } from "../db/projects";
import { getSetting, setSetting } from "../db/settings";
import {
  DEFAULT_NOTE_TITLE,
  parseAppleNote,
  readAppleNote,
  renderAppleNoteBody,
  writeAppleNote,
} from "../integrations/apple-notes";

export const NOTES_TITLE_KEY = "apple_notes_title";

export function getNotesTitle(): string {
  return getSetting(NOTES_TITLE_KEY) ?? DEFAULT_NOTE_TITLE;
}

export function setNotesTitle(title: string): void {
  setSetting(NOTES_TITLE_KEY, title);
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
 */
export async function syncWithAppleNotes(): Promise<SyncStats> {
  const title = getNotesTitle();
  let pulledNew = 0;
  let pulledUpdated = 0;

  const body = await readAppleNote(title);
  if (body !== null) {
    const lines = parseAppleNote(body);
    for (const line of lines) {
      const existing = getBacklogItemByExternalId(line.externalId);
      if (existing) {
        // Note: an item checked-off in the note flips DB to "done."
        // Conversely, un-checking in the note does NOT un-do the item
        // — irreversible by design (closes the loop).
        if (line.done && existing.status !== "done") {
          updateBacklogItem(existing.id, { status: "done" });
          pulledUpdated += 1;
        }
        continue;
      }
      createBacklogItem({
        title: line.text,
        source: "apple-notes",
        external_id: line.externalId,
        status: line.done ? "done" : "idea",
        // Preserve the date in the note's `· added YYYY-MM-DD` suffix
        // so a DB rebuild from the note doesn't reset every item's
        // history to "today." Falls back to `unixepoch()` when the
        // line had no parseable suffix (user-typed bullet with no
        // suffix yet).
        ...(line.createdAt !== null ? { created_at: line.createdAt } : {}),
      });
      pulledNew += 1;
    }
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
  await writeAppleNote(title, renderAppleNoteBody(renderable));

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
    const items = listBacklog();
    const renderable = items
      .filter((i) => i.status !== "dropped")
      .map((i) => ({
        title: i.title,
        status: i.status,
        createdAt: i.created_at,
      }));
    await writeAppleNote(title, renderAppleNoteBody(renderable));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
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
