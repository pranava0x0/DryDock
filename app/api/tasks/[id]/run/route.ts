import type { NextRequest } from "next/server";
import {
  runTaskWithCap,
  DispatchError,
} from "@/lib/orchestrator/dispatch";
import { accepted, conflict, notFound, ok, serverError } from "@/lib/api/json";
import { rejectRemoteDispatch } from "@/lib/api/local-only";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Claim + dispatch the task, then return the run id without waiting for the
 * agent to finish. The client connects to /stream to consume events.
 *
 * When the concurrency cap is full the task is queued instead and the
 * route answers 202 with its queue position; the dispatcher drains the
 * queue FIFO as running tasks finish.
 *
 * The dispatcher publishes events to the hub regardless of whether anyone is
 * subscribed, so the run still completes and persists even if /stream is
 * never opened. SSE is a "look at the live tail" view, not the source of
 * truth.
 */
export async function POST(
  request: NextRequest,
  ctx: RouteContext,
): Promise<Response> {
  const localOnly = rejectRemoteDispatch(request);
  if (localOnly) return localOnly;
  const { id } = await ctx.params;
  try {
    const result = runTaskWithCap(id);
    if (result.queued) {
      return accepted({ queued: true, position: result.position });
    }
    // Detach the completion promise. The unhandled-rejection guard is a
    // belt-and-suspenders — dispatchTask's `finally` already records failure.
    result.done.catch(() => {});
    return ok({ runId: result.runId });
  } catch (err) {
    if (err instanceof DispatchError) {
      if (err.code === "task_not_found" || err.code === "project_not_found") {
        return notFound(err.message);
      }
      if (err.code === "already_claimed") {
        return conflict(err.message);
      }
    }
    return serverError((err as Error).message);
  }
}
