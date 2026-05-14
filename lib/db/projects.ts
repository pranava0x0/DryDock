import { nanoid } from "nanoid";
import { getDb } from "./index";
import type { ProviderName } from "../providers/types";

export interface Project {
  id: string;
  name: string;
  path: string;
  description: string | null;
  provider: ProviderName;
  /** Shell command run after the agent exits 0; null = quality gate skipped. */
  test_command: string | null;
  created_at: number;
}

export interface NewProjectInput {
  name: string;
  path: string;
  description?: string | null;
  provider?: ProviderName;
  test_command?: string | null;
}

export interface UpdateProjectInput {
  name?: string;
  path?: string;
  description?: string | null;
  provider?: ProviderName;
  test_command?: string | null;
}

export function listProjects(): Project[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, name, path, description, provider, test_command, created_at
       FROM projects ORDER BY created_at DESC`,
    )
    .all() as Project[];
}

export function getProject(id: string): Project | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, name, path, description, provider, test_command, created_at
       FROM projects WHERE id = ?`,
    )
    .get(id) as Project | undefined;
  return row ?? null;
}

export function createProject(input: NewProjectInput): Project {
  const db = getDb();
  const id = nanoid();
  const provider = input.provider ?? "claude";
  db.prepare(
    `INSERT INTO projects (id, name, path, description, provider, test_command)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.name,
    input.path,
    input.description ?? null,
    provider,
    input.test_command ?? null,
  );
  const created = getProject(id);
  if (!created) {
    // Should never happen — we just inserted this row.
    throw new Error(`createProject: row not found after insert (id=${id})`);
  }
  return created;
}

export function updateProject(
  id: string,
  patch: UpdateProjectInput,
): Project | null {
  const existing = getProject(id);
  if (!existing) return null;

  // Build an UPDATE only over the columns the caller actually passed. This
  // keeps unrelated fields untouched and avoids defaulting them to null.
  const fields: string[] = [];
  const values: unknown[] = [];
  if (patch.name !== undefined) {
    fields.push("name = ?");
    values.push(patch.name);
  }
  if (patch.path !== undefined) {
    fields.push("path = ?");
    values.push(patch.path);
  }
  if (patch.description !== undefined) {
    fields.push("description = ?");
    values.push(patch.description);
  }
  if (patch.provider !== undefined) {
    fields.push("provider = ?");
    values.push(patch.provider);
  }
  if (patch.test_command !== undefined) {
    fields.push("test_command = ?");
    values.push(patch.test_command);
  }

  if (fields.length === 0) return existing;

  const db = getDb();
  values.push(id);
  db.prepare(`UPDATE projects SET ${fields.join(", ")} WHERE id = ?`).run(
    ...values,
  );
  return getProject(id);
}

export function deleteProject(id: string): boolean {
  const db = getDb();
  const info = db.prepare(`DELETE FROM projects WHERE id = ?`).run(id);
  return info.changes > 0;
}
