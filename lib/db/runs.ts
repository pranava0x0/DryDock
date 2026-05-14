import { nanoid } from "nanoid";
import { getDb } from "./index";
import type { ProviderName } from "../providers/types";

export type RunStatus = "running" | "success" | "failed";
export type GateStatus = "passed" | "failed";

export interface Run {
  id: string;
  task_id: string;
  provider: ProviderName;
  status: RunStatus;
  output: string | null;
  error: string | null;
  /** Input/output tokens captured from claude stream-json `result` events. */
  tokens_in: number | null;
  tokens_out: number | null;
  /** Cost in USD reported by the provider (claude only, currently). */
  cost_usd: number | null;
  /** Quality-gate result (null when the gate wasn't run for this run). */
  gate_status: GateStatus | null;
  gate_output: string | null;
  started_at: number;
  completed_at: number | null;
}

export function createRun(taskId: string, provider: ProviderName): Run {
  const db = getDb();
  const id = nanoid();
  db.prepare(
    `INSERT INTO runs (id, task_id, provider, status)
     VALUES (?, ?, ?, 'running')`,
  ).run(id, taskId, provider);
  const created = getRun(id);
  if (!created) {
    throw new Error(`createRun: row not found after insert (id=${id})`);
  }
  return created;
}

export function getRun(id: string): Run | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, task_id, provider, status, output, error,
              tokens_in, tokens_out, cost_usd,
              gate_status, gate_output,
              started_at, completed_at
       FROM runs WHERE id = ?`,
    )
    .get(id) as Run | undefined;
  return row ?? null;
}

export function listRunsForTask(taskId: string): Run[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, task_id, provider, status, output, error,
              tokens_in, tokens_out, cost_usd,
              gate_status, gate_output,
              started_at, completed_at
       FROM runs
       WHERE task_id = ?
       ORDER BY started_at DESC`,
    )
    .all(taskId) as Run[];
}

export function getLatestRunForTask(taskId: string): Run | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, task_id, provider, status, output, error,
              tokens_in, tokens_out, cost_usd,
              gate_status, gate_output,
              started_at, completed_at
       FROM runs
       WHERE task_id = ?
       ORDER BY started_at DESC
       LIMIT 1`,
    )
    .get(taskId) as Run | undefined;
  return row ?? null;
}

export interface CompleteRunInput {
  status: "success" | "failed";
  output?: string | null;
  error?: string | null;
  tokens_in?: number | null;
  tokens_out?: number | null;
  cost_usd?: number | null;
  gate_status?: GateStatus | null;
  gate_output?: string | null;
}

/**
 * Mark a run terminal. Used by the dispatcher when the agent subprocess exits.
 * `completed_at` is stamped at SQL time so it matches the DB's clock, which
 * matters when the orchestrator and the UI compare timestamps.
 */
export function completeRun(id: string, input: CompleteRunInput): Run | null {
  const existing = getRun(id);
  if (!existing) return null;
  const db = getDb();
  db.prepare(
    `UPDATE runs
     SET status = ?,
         output = ?,
         error = ?,
         tokens_in = ?,
         tokens_out = ?,
         cost_usd = ?,
         gate_status = ?,
         gate_output = ?,
         completed_at = unixepoch()
     WHERE id = ?`,
  ).run(
    input.status,
    input.output ?? null,
    input.error ?? null,
    input.tokens_in ?? null,
    input.tokens_out ?? null,
    input.cost_usd ?? null,
    input.gate_status ?? null,
    input.gate_output ?? null,
    id,
  );
  return getRun(id);
}
