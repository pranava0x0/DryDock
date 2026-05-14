import { nanoid } from "nanoid";
import { getDb } from "./index";
import type { ProviderName } from "../providers/types";

export type TaskStatus = "pending" | "claimed" | "running" | "done" | "failed";

export const TASK_STATUSES: readonly TaskStatus[] = [
  "pending",
  "claimed",
  "running",
  "done",
  "failed",
] as const;

export interface Task {
  id: string;
  project_id: string;
  title: string;
  description: string;
  provider: ProviderName;
  status: TaskStatus;
  priority: number;
  branch: string | null;
  worktree_path: string | null;
  pr_url: string | null;
  created_at: number;
  updated_at: number;
  claimed_at: number | null;
  completed_at: number | null;
}

export interface NewTaskInput {
  project_id: string;
  title: string;
  description: string;
  provider?: ProviderName;
  priority?: number;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  provider?: ProviderName;
  status?: TaskStatus;
  priority?: number;
  branch?: string | null;
  worktree_path?: string | null;
  pr_url?: string | null;
}

export interface ListTasksFilter {
  projectId?: string;
  status?: TaskStatus;
}

export function listTasks(filter: ListTasksFilter = {}): Task[] {
  const db = getDb();
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.projectId) {
    where.push("project_id = ?");
    params.push(filter.projectId);
  }
  if (filter.status) {
    where.push("status = ?");
    params.push(filter.status);
  }
  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return db
    .prepare(
      `SELECT id, project_id, title, description, provider, status, priority,
              branch, worktree_path, pr_url, created_at, updated_at,
              claimed_at, completed_at
       FROM tasks
       ${whereClause}
       ORDER BY priority DESC, created_at DESC`,
    )
    .all(...params) as Task[];
}

export function getTask(id: string): Task | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, project_id, title, description, provider, status, priority,
              branch, worktree_path, pr_url, created_at, updated_at,
              claimed_at, completed_at
       FROM tasks WHERE id = ?`,
    )
    .get(id) as Task | undefined;
  return row ?? null;
}

export function createTask(input: NewTaskInput): Task {
  const db = getDb();
  const id = nanoid();
  const provider = input.provider ?? "claude";
  const priority = input.priority ?? 0;
  db.prepare(
    `INSERT INTO tasks (id, project_id, title, description, provider, priority)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, input.project_id, input.title, input.description, provider, priority);
  const created = getTask(id);
  if (!created) {
    throw new Error(`createTask: row not found after insert (id=${id})`);
  }
  return created;
}

export function updateTask(
  id: string,
  patch: UpdateTaskInput,
): Task | null {
  const existing = getTask(id);
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
  if (patch.provider !== undefined) {
    fields.push("provider = ?");
    values.push(patch.provider);
  }
  if (patch.status !== undefined) {
    fields.push("status = ?");
    values.push(patch.status);
    // Stamp completed_at when the task reaches a terminal state so the UI can
    // sort or show "X minutes ago" without re-scanning runs.
    if (patch.status === "done" || patch.status === "failed") {
      fields.push("completed_at = unixepoch()");
    }
  }
  if (patch.priority !== undefined) {
    fields.push("priority = ?");
    values.push(patch.priority);
  }
  if (patch.branch !== undefined) {
    fields.push("branch = ?");
    values.push(patch.branch);
  }
  if (patch.worktree_path !== undefined) {
    fields.push("worktree_path = ?");
    values.push(patch.worktree_path);
  }
  if (patch.pr_url !== undefined) {
    fields.push("pr_url = ?");
    values.push(patch.pr_url);
  }

  if (fields.length === 0) return existing;

  // Always bump updated_at so the UI can show a "last activity" timestamp.
  fields.push("updated_at = unixepoch()");

  const db = getDb();
  values.push(id);
  db.prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`).run(
    ...values,
  );
  return getTask(id);
}

export function deleteTask(id: string): boolean {
  const db = getDb();
  const info = db.prepare(`DELETE FROM tasks WHERE id = ?`).run(id);
  return info.changes > 0;
}

/**
 * Atomically claim a pending task.
 *
 * Returns `true` only when this caller is the one that moved the row from
 * `pending` to `claimed`. Concurrent dispatchers will get `false` and must
 * back off — without this guarantee, two processes could spawn duplicate
 * agents on the same task.
 *
 * The `WHERE id = ? AND status = 'pending'` clause makes the transition a
 * compare-and-swap. `info.changes` is the source of truth: 1 = we won, 0 =
 * either the task doesn't exist, was already claimed, or has moved on.
 */
export function claimTask(id: string): boolean {
  const db = getDb();
  const info = db
    .prepare(
      `UPDATE tasks
       SET status = 'claimed', claimed_at = unixepoch(), updated_at = unixepoch()
       WHERE id = ? AND status = 'pending'`,
    )
    .run(id);
  return info.changes === 1;
}

export interface TaskCountsByStatus {
  pending: number;
  claimed: number;
  running: number;
  done: number;
  failed: number;
}

/**
 * Return a status histogram for a project. Used by the dashboard card so it
 * can show "3 pending / 1 running" without round-tripping every task row.
 */
export function taskCountsByProject(projectId: string): TaskCountsByStatus {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT status, COUNT(*) AS n
       FROM tasks
       WHERE project_id = ?
       GROUP BY status`,
    )
    .all(projectId) as Array<{ status: TaskStatus; n: number }>;
  const counts: TaskCountsByStatus = {
    pending: 0,
    claimed: 0,
    running: 0,
    done: 0,
    failed: 0,
  };
  for (const row of rows) counts[row.status] = row.n;
  return counts;
}
