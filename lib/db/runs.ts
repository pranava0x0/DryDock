import { nanoid } from "nanoid";
import { getDb } from "./index";
import type { ProviderName } from "../providers/types";

export type RunStatus = "running" | "success" | "failed";
export type GateStatus = "passed" | "failed";
/**
 * Why a failed run failed. `cancelled` = user hit Stop; `gate_failed` =
 * agent exited 0 but the quality gate demoted it; `agent_exit` = the agent
 * subprocess itself exited non-zero (includes timeouts and spawn errors).
 */
export type FailureReason = "cancelled" | "gate_failed" | "agent_exit";

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
  /** Label of the routing rule that overrode provider/model at dispatch time. */
  matched_rule: string | null;
  /** Why the run failed; null on success and on pre-column legacy rows. */
  failure_reason: FailureReason | null;
  /** Provider session id for `--resume`; null when not reported. */
  session_id: string | null;
  /** The run this one continues (follow-up); null for a task's first run. */
  parent_run_id: string | null;
  started_at: number;
  completed_at: number | null;
}

export interface CreateRunOptions {
  matchedRule?: string | null;
  /** Set for a follow-up run so the UI can render the thread. */
  parentRunId?: string | null;
}

export function createRun(
  taskId: string,
  provider: ProviderName,
  options: CreateRunOptions = {},
): Run {
  const db = getDb();
  const id = nanoid();
  db.prepare(
    `INSERT INTO runs (id, task_id, provider, status, matched_rule, parent_run_id)
     VALUES (?, ?, ?, 'running', ?, ?)`,
  ).run(
    id,
    taskId,
    provider,
    options.matchedRule ?? null,
    options.parentRunId ?? null,
  );
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
              gate_status, gate_output, matched_rule, failure_reason,
              session_id, parent_run_id,
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
              gate_status, gate_output, matched_rule, failure_reason,
              session_id, parent_run_id,
              started_at, completed_at
       FROM runs
       WHERE task_id = ?
       -- rowid tiebreak: started_at is unixepoch() seconds, so a follow-up
       -- created in the same second as its parent must still sort after it.
       ORDER BY started_at DESC, rowid DESC`,
    )
    .all(taskId) as Run[];
}

export function getLatestRunForTask(taskId: string): Run | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, task_id, provider, status, output, error,
              tokens_in, tokens_out, cost_usd,
              gate_status, gate_output, matched_rule, failure_reason,
              session_id, parent_run_id,
              started_at, completed_at
       FROM runs
       WHERE task_id = ?
       -- rowid tiebreak: see listRunsForTask — a same-second follow-up must
       -- win over its parent, or the SSE route would stream the wrong run.
       ORDER BY started_at DESC, rowid DESC
       LIMIT 1`,
    )
    .get(taskId) as Run | undefined;
  return row ?? null;
}

export interface TaskRunAggregate {
  /** How many runs this task has had (1 = never followed up). */
  run_count: number;
  /** Summed cost across every run in the thread; null when none reported. */
  total_cost_usd: number | null;
}

/**
 * Roll a task's runs into a thread summary for the card: turn count and
 * total spend. Cheap enough to compute per-task in the list route.
 */
export function taskRunAggregate(taskId: string): TaskRunAggregate {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n, SUM(cost_usd) AS total
       FROM runs WHERE task_id = ?`,
    )
    .get(taskId) as { n: number; total: number | null };
  return { run_count: row.n, total_cost_usd: row.total ?? null };
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
  failure_reason?: FailureReason | null;
  session_id?: string | null;
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
         failure_reason = ?,
         session_id = ?,
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
    input.failure_reason ?? null,
    input.session_id ?? null,
    id,
  );
  return getRun(id);
}
