import { getRun, type Run } from "../db/runs";

export type ReplayPayload =
  | { type: "stdout"; data: string }
  | { type: "stderr"; data: string }
  | { type: "exit"; data: string; code: number };

export type ReplaySend = (payload: ReplayPayload) => void;

/**
 * Replay a terminated run from the database. Used by the SSE route when the
 * in-memory hub no longer has the run's event history (server restart, HMR)
 * or when the run was already terminal at connection time.
 *
 * Surfaces three pieces of state separately so a viewer can distinguish them:
 *   - runs.output: the agent's combined stdout (incl. drydock-prefixed notes)
 *   - runs.error: stderr + dispatch-level failures
 *   - runs.gate_output: the test command's transcript — the diagnostic the
 *     user needs to understand a failed gate, which would otherwise be lost
 *     because the live stream only buffers a 1-line verdict.
 */
export function replayFromDb(runId: string, send: ReplaySend): void {
  const run: Run | null = getRun(runId);
  if (!run) return;
  if (run.output && run.output.length > 0) {
    send({ type: "stdout", data: run.output });
  }
  if (run.error && run.error.length > 0) {
    send({ type: "stderr", data: run.error });
  }
  if (run.gate_output && run.gate_output.length > 0) {
    send({
      type: run.gate_status === "failed" ? "stderr" : "stdout",
      data: `[drydock] quality gate output:\n${run.gate_output}`,
    });
  }
  if (run.status !== "running") {
    send({
      type: "exit",
      data: run.status,
      code: run.status === "success" ? 0 : -1,
    });
  }
}
