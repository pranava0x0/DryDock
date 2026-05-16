import { nanoid } from "nanoid";
import { getDb } from "./index";

export type BacklogStatus = "idea" | "in_progress" | "done" | "dropped";
export type BacklogSource = "manual" | "apple-notes";

export const BACKLOG_STATUSES: readonly BacklogStatus[] = [
  "idea",
  "in_progress",
  "done",
  "dropped",
] as const;

export interface BacklogItem {
  id: string;
  title: string;
  description: string | null;
  /** Nullable — items without a project are "general" / unassigned. */
  project_id: string | null;
  status: BacklogStatus;
  priority: number;
  source: BacklogSource;
  /** Stable line key for Apple Notes sync dedup. Null for manual items. */
  external_id: string | null;
  /** Task id created when the item is burned down. */
  task_id: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface NewBacklogInput {
  title: string;
  description?: string | null;
  project_id?: string | null;
  status?: BacklogStatus;
  priority?: number;
  source?: BacklogSource;
  external_id?: string | null;
  /**
   * Optional Unix-seconds creation timestamp. Used by the Apple Notes
   * sync to preserve `· added YYYY-MM-DD` history when rebuilding a
   * wiped DB from the note. When omitted, SQLite stamps `created_at`
   * via the `unixepoch()` default.
   */
  created_at?: number;
}

export interface UpdateBacklogInput {
  title?: string;
  description?: string | null;
  project_id?: string | null;
  status?: BacklogStatus;
  priority?: number;
  task_id?: string | null;
  /**
   * Allow promoting a manual-source row to apple-notes (and stamping
   * its external_id) when the sync pull finds an existing same-title
   * row that pre-dates the POST-stamps-external_id fix.
   */
  external_id?: string | null;
  source?: BacklogSource;
}

export interface ListBacklogFilter {
  status?: BacklogStatus;
  projectId?: string | "unassigned";
}

const SELECT_COLUMNS = `id, title, description, project_id, status, priority,
  source, external_id, task_id, created_at, updated_at, completed_at`;

export function listBacklog(
  filter: ListBacklogFilter = {},
): BacklogItem[] {
  const db = getDb();
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.status) {
    where.push("status = ?");
    params.push(filter.status);
  }
  if (filter.projectId === "unassigned") {
    where.push("project_id IS NULL");
  } else if (filter.projectId) {
    where.push("project_id = ?");
    params.push(filter.projectId);
  }
  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return db
    .prepare(
      `SELECT ${SELECT_COLUMNS}
       FROM backlog_items
       ${whereClause}
       ORDER BY priority DESC, created_at DESC`,
    )
    .all(...params) as BacklogItem[];
}

export function getBacklogItem(id: string): BacklogItem | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM backlog_items WHERE id = ?`,
    )
    .get(id) as BacklogItem | undefined;
  return row ?? null;
}

export function getBacklogItemByExternalId(
  externalId: string,
): BacklogItem | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM backlog_items WHERE external_id = ?`,
    )
    .get(externalId) as BacklogItem | undefined;
  return row ?? null;
}

/**
 * Case-folded, trimmed title lookup. Used by the Apple Notes sync to
 * claim pre-existing manual rows (external_id IS NULL) that match a
 * pulled line, instead of minting a second copy under
 * source='apple-notes'. Returns the oldest match so a future re-sync
 * is deterministic when duplicates somehow already exist.
 */
export function getBacklogItemByTitle(title: string): BacklogItem | null {
  const normalized = title.trim().toLowerCase();
  if (normalized.length === 0) return null;
  const db = getDb();
  const row = db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM backlog_items
       WHERE LOWER(TRIM(title)) = ?
       ORDER BY created_at ASC
       LIMIT 1`,
    )
    .get(normalized) as BacklogItem | undefined;
  return row ?? null;
}

export function createBacklogItem(input: NewBacklogInput): BacklogItem {
  const db = getDb();
  const id = nanoid();
  // When the caller provides a created_at (e.g. Apple Notes sync
  // rebuilding a wiped DB from `· added YYYY-MM-DD` suffixes), insert
  // it explicitly so updated_at gets the same value — the row should
  // read as historically created, not as "modified today." Without the
  // override, SQLite's unixepoch() defaults stamp both columns with
  // today's time.
  if (typeof input.created_at === "number" && Number.isFinite(input.created_at)) {
    db.prepare(
      `INSERT INTO backlog_items
         (id, title, description, project_id, status, priority, source, external_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.title,
      input.description ?? null,
      input.project_id ?? null,
      input.status ?? "idea",
      input.priority ?? 0,
      input.source ?? "manual",
      input.external_id ?? null,
      input.created_at,
      input.created_at,
    );
  } else {
    db.prepare(
      `INSERT INTO backlog_items
         (id, title, description, project_id, status, priority, source, external_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.title,
      input.description ?? null,
      input.project_id ?? null,
      input.status ?? "idea",
      input.priority ?? 0,
      input.source ?? "manual",
      input.external_id ?? null,
    );
  }
  const created = getBacklogItem(id);
  if (!created) {
    throw new Error(`createBacklogItem: row not found after insert (id=${id})`);
  }
  return created;
}

export function updateBacklogItem(
  id: string,
  patch: UpdateBacklogInput,
): BacklogItem | null {
  const existing = getBacklogItem(id);
  if (!existing) return null;

  const fields: string[] = [];
  const values: unknown[] = [];
  if (patch.title !== undefined) {
    fields.push("title = ?");
    values.push(patch.title);
  }
  if (patch.description !== undefined) {
    fields.push("description = ?");
    values.push(patch.description);
  }
  if (patch.project_id !== undefined) {
    fields.push("project_id = ?");
    values.push(patch.project_id);
  }
  if (patch.status !== undefined) {
    fields.push("status = ?");
    values.push(patch.status);
    if (patch.status === "done" || patch.status === "dropped") {
      fields.push("completed_at = unixepoch()");
    }
  }
  if (patch.priority !== undefined) {
    fields.push("priority = ?");
    values.push(patch.priority);
  }
  if (patch.task_id !== undefined) {
    fields.push("task_id = ?");
    values.push(patch.task_id);
  }
  if (patch.external_id !== undefined) {
    fields.push("external_id = ?");
    values.push(patch.external_id);
  }
  if (patch.source !== undefined) {
    fields.push("source = ?");
    values.push(patch.source);
  }

  if (fields.length === 0) return existing;

  // Always bump updated_at so the UI's "X minutes ago" stays accurate
  // and so the Apple Notes sync can pick the freshest copy.
  fields.push("updated_at = unixepoch()");

  const db = getDb();
  values.push(id);
  db.prepare(
    `UPDATE backlog_items SET ${fields.join(", ")} WHERE id = ?`,
  ).run(...values);
  return getBacklogItem(id);
}

export function deleteBacklogItem(id: string): boolean {
  const db = getDb();
  const info = db
    .prepare(`DELETE FROM backlog_items WHERE id = ?`)
    .run(id);
  return info.changes > 0;
}
