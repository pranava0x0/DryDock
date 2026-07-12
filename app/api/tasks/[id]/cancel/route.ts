import type { NextRequest } from "next/server";
import { getTask, unqueueTask } from "@/lib/db/tasks";
import { getLatestRunForTask } from "@/lib/db/runs";
import { cancelActiveRun } from "@/lib/orchestrator/dispatch";
import { notFound, ok } from "@/lib/api/json";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Stop a task. Three cases, all idempotent:
 *
 * - queued  → CAS back to pending (it never started; nothing to kill).
 * - running → abort the live run's subprocess. The dispatcher's finalizer
 *             persists partial output, stamps failure_reason='cancelled',
 *             and keeps the worktree for inspection (same as any failure).
 * - already terminal / nothing live → report state unchanged. Cancelling
 *             twice, or racing the run's natural completion, is a no-op —
 *             never an error the phone user has to think about.
 */
export async function POST(
  _request: NextRequest,
  ctx: RouteContext,
): Promise<Response> {
  const { id } = await ctx.params;
  const task = getTask(id);
  if (!task) return notFound(`Task not found: ${id}`);

  if (task.status === "queued") {
    const unqueued = unqueueTask(id);
    // CAS lost = the drain just claimed it; fall through to the live-run
    // path so the fresh subprocess still gets the kill.
    if (unqueued) return ok({ cancelled: true, was: "queued" });
  }

  const latestRun = getLatestRunForTask(id);
  if (latestRun && cancelActiveRun(latestRun.id)) {
    return ok({ cancelled: true, was: "running", runId: latestRun.id });
  }

  return ok({ cancelled: false, alreadyTerminal: true, status: task.status });
}
