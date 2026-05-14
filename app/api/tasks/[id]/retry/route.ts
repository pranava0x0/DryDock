import type { NextRequest } from "next/server";
import { getTask, updateTask } from "@/lib/db/tasks";
import { badRequest, notFound, ok } from "@/lib/api/json";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Re-arm a failed task so the user can re-dispatch it.
 *
 * We move the task back to `pending` (and clear the branch/worktree
 * pointers so a fresh worktree is created on the next run). The user
 * still has to hit "Run" — keeping retry as two clicks gives them a
 * chance to edit the description before re-dispatching.
 *
 * Limitation: prior runs are kept in the DB for history. A future
 * version could let the user inspect them via a "View output" affordance
 * on the re-armed task card.
 */
export async function POST(
  _request: NextRequest,
  ctx: RouteContext,
): Promise<Response> {
  const { id } = await ctx.params;
  const task = getTask(id);
  if (!task) return notFound(`Task not found: ${id}`);
  if (task.status !== "failed") {
    return badRequest(
      `Task is in status '${task.status}'; only failed tasks can be retried`,
    );
  }

  const updated = updateTask(id, {
    status: "pending",
    branch: null,
    worktree_path: null,
  });
  return ok({ task: updated });
}
