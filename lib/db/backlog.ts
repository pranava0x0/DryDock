import { nanoid } from "nanoid";
import { getDb } from "./index";

export type BacklogStatus =
  | "idea"
  | "in_progress"
  | "done"
  | "dropped"
  /**
   * Machine-generated and not yet accepted by a human (EP-14). Lives in
   * the inbox with a 🤖 chip. Distinct from `idea` so the nightly idea
   * generator can never quietly grow the trusted backlog.
   */
  | "proposed";

export type BacklogSource =
  | "manual"
  | "apple-notes"
  | "shortcut"
  | "imessage"
  | "ai-generated"
  | "github"
  | "project-file";

export const BACKLOG_STATUSES: readonly BacklogStatus[] = [
  "idea",
  "in_progress",
  "done",
  "dropped",
  "proposed",
] as const;

export const BACKLOG_SOURCES: readonly BacklogSource[] = [
  "manual",
  "apple-notes",
  "shortcut",
  "imessage",
  "ai-generated",
  "github",
  "project-file",
] as const;

export function isBacklogSource(value: unknown): value is BacklogSource {
  return (
    typeof value === "string" &&
    (BACKLOG_SOURCES as readonly string[]).includes(value)
  );
}

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
  /**
   * When a human accepted this into the trusted backlog. NULL = inbox.
   * Notes-sourced rows are pre-triaged: typing into the Apple Note is
   * already a deliberate act on a trusted surface.
   */
  triaged_at: number | null;
  /** The capture text exactly as it arrived. Parsing is never destructive. */
  raw_capture: string | null;
  /** "owner/repo#42" once mirrored to the GitHub tracker (EP-13). */
  github_issue_ref: string | null;
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
  triaged_at?: number | null;
  raw_capture?: string | null;
  github_issue_ref?: string | null;
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
  triaged_at?: number | null;
  github_issue_ref?: string | null;
}

export interface ListBacklogFilter {
  status?: BacklogStatus;
  projectId?: string | "unassigned";
  /**
   * "inbox" = untriaged only; "triaged" = the trusted backlog only.
   * Omit for everything. The default across the app is deliberately
   * *not* "everything" — the point of the inbox is that raw captures
   * don't pollute the list you trust.
   */
  stage?: "inbox" | "triaged";
}

const SELECT_COLUMNS = `id, title, description, project_id, status, priority,
  source, external_id, task_id, triaged_at, raw_capture, github_issue_ref,
  created_at, updated_at, completed_at`;

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
  if (filter.stage === "inbox") {
    where.push("triaged_at IS NULL");
  } else if (filter.stage === "triaged") {
    where.push("triaged_at IS NOT NULL");
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
         (id, title, description, project_id, status, priority, source,
          external_id, triaged_at, raw_capture, github_issue_ref,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.title,
      input.description ?? null,
      input.project_id ?? null,
      input.status ?? "idea",
      input.priority ?? 0,
      input.source ?? "manual",
      input.external_id ?? null,
      defaultTriagedAt(input),
      input.raw_capture ?? null,
      input.github_issue_ref ?? null,
      input.created_at,
      input.created_at,
    );
  } else {
    db.prepare(
      `INSERT INTO backlog_items
         (id, title, description, project_id, status, priority, source,
          external_id, triaged_at, raw_capture, github_issue_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.title,
      input.description ?? null,
      input.project_id ?? null,
      input.status ?? "idea",
      input.priority ?? 0,
      input.source ?? "manual",
      input.external_id ?? null,
      defaultTriagedAt(input),
      input.raw_capture ?? null,
      input.github_issue_ref ?? null,
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
  if (patch.triaged_at !== undefined) {
    fields.push("triaged_at = ?");
    values.push(patch.triaged_at);
  }
  if (patch.github_issue_ref !== undefined) {
    fields.push("github_issue_ref = ?");
    values.push(patch.github_issue_ref);
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

/**
 * Which sources land pre-triaged.
 *
 * The inbox exists to keep *raw captures* out of the trusted list, not to
 * add a step to deliberate entries. Typing into the DryDock UI or into
 * the Apple Note is already a considered act on a trusted surface, so
 * those bypass it — and that keeps the Apple Notes sync's behaviour
 * bit-for-bit unchanged, which its tests depend on. Everything that
 * arrives from a five-second channel or a machine goes to the inbox.
 */
const PRE_TRIAGED_SOURCES: readonly BacklogSource[] = [
  "manual",
  "apple-notes",
];

function defaultTriagedAt(input: NewBacklogInput): number | null {
  if (input.triaged_at !== undefined) return input.triaged_at;
  const source = input.source ?? "manual";
  return PRE_TRIAGED_SOURCES.includes(source)
    ? (input.created_at ?? Math.floor(Date.now() / 1000))
    : null;
}

/** Accept an inbox item into the trusted backlog. */
export function triageBacklogItem(
  id: string,
  at: number = Math.floor(Date.now() / 1000),
): BacklogItem | null {
  const existing = getBacklogItem(id);
  if (!existing) return null;
  return updateBacklogItem(id, {
    triaged_at: at,
    // A machine proposal becomes a real idea the moment a human accepts
    // it. Leaving it `proposed` would keep it filtered out of the list
    // it was just promoted into.
    ...(existing.status === "proposed" ? { status: "idea" as const } : {}),
  });
}

/** Count of untriaged rows — the Inbox (n) badge. */
export function inboxCount(): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM backlog_items WHERE triaged_at IS NULL`,
    )
    .get() as { n: number } | undefined;
  return row?.n ?? 0;
}

export function deleteBacklogItem(id: string): boolean {
  const db = getDb();
  const info = db
    .prepare(`DELETE FROM backlog_items WHERE id = ?`)
    .run(id);
  return info.changes > 0;
}
