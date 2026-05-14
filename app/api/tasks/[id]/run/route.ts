import type { NextRequest } from "next/server";
import {
  dispatchTask,
  DispatchError,
} from "@/lib/orchestrator/dispatch";
import { conflict, notFound, ok, serverError } from "@/lib/api/json";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Claim + dispatch the task, then return the run id without waiting for the
 * agent to finish. The client connects to /stream to consume events.
 *
 * The dispatcher publishes events to the hub regardless of whether anyone is
 * subscribed, so the run still completes and persists even if /stream is
 * never opened. SSE is a "look at the live tail" view, not the source of
 * truth.
 */
export async function POST(
  _request: NextRequest,
  ctx: RouteContext,
): Promise<Response> {
  const { id } = await ctx.params;
  try {
    const { runId, done } = dispatchTask(id);
    // Detach the completion promise. The unhandled-rejection guard is a
    // belt-and-suspenders — dispatchTask's `finally` already records failure.
    done.catch(() => {});
    return ok({ runId });
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
