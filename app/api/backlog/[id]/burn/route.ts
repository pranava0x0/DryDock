import type { NextRequest } from "next/server";
import {
  burnDownBacklogItem,
  BurnDownError,
} from "@/lib/orchestrator/backlog";
import { badRequest, notFound, ok, serverError } from "@/lib/api/json";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Burn down a backlog item into an orchestrator task. The user can
 * optionally pass `project_id` in the body to override (or set) the
 * project the task should be created under.
 *
 * Returns `{ taskId, backlogId }` so the UI can navigate the user
 * straight to the task they just created.
 */
export async function POST(
  request: NextRequest,
  ctx: RouteContext,
): Promise<Response> {
  const { id } = await ctx.params;
  let projectIdOverride: string | null | undefined;
  try {
    const body = await request.json().catch(() => ({}));
    if (body && typeof body === "object" && "project_id" in body) {
      const v = (body as Record<string, unknown>).project_id;
      if (v === null) projectIdOverride = null;
      else if (typeof v === "string") projectIdOverride = v;
      else return badRequest("`project_id` must be a string or null");
    }
  } catch {
    // empty body is fine — we'll fall back to the item's stored project_id
  }

  try {
    const result = burnDownBacklogItem(id, projectIdOverride);
    return ok(result);
  } catch (err) {
    if (err instanceof BurnDownError) {
      if (
        err.code === "item_not_found" ||
        err.code === "project_not_found"
      ) {
        return notFound(err.message);
      }
      if (err.code === "project_required") {
        return badRequest(err.message);
      }
    }
    return serverError((err as Error).message);
  }
}
