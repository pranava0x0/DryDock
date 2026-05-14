import type { NextRequest } from "next/server";
import {
  deleteTask,
  getTask,
  TASK_STATUSES,
  type TaskStatus,
  updateTask,
} from "@/lib/db/tasks";
import { listRunsForTask } from "@/lib/db/runs";
import { isProviderName } from "@/lib/providers";
import {
  badRequest,
  notFound,
  ok,
  serverError,
} from "@/lib/api/json";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(
  _request: NextRequest,
  ctx: RouteContext,
): Promise<Response> {
  const { id } = await ctx.params;
  const task = getTask(id);
  if (!task) return notFound(`Task not found: ${id}`);
  // Tasks are usually viewed alongside their run history (the stream view
  // wants to show prior attempts), so attach runs in the same payload to
  // save a follow-up request.
  const runs = listRunsForTask(id);
  return ok({ task, runs });
}

export async function PATCH(
  request: NextRequest,
  ctx: RouteContext,
): Promise<Response> {
  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("Request body must be valid JSON");
  }
  if (typeof body !== "object" || body === null) {
    return badRequest("Request body must be an object");
  }
  const raw = body as Record<string, unknown>;
  const patch: {
    title?: string;
    description?: string;
    provider?: "claude" | "gemini";
    status?: TaskStatus;
    priority?: number;
  } = {};

  if (raw.title !== undefined) {
    if (typeof raw.title !== "string" || raw.title.trim() === "") {
      return badRequest("`title` must be a non-empty string");
    }
    patch.title = raw.title.trim();
  }
  if (raw.description !== undefined) {
    if (typeof raw.description !== "string" || raw.description.trim() === "") {
      return badRequest("`description` must be a non-empty string");
    }
    patch.description = raw.description.trim();
  }
  if (raw.provider !== undefined) {
    if (!isProviderName(raw.provider)) {
      return badRequest("`provider` must be 'claude' or 'gemini'");
    }
    patch.provider = raw.provider;
  }
  if (raw.status !== undefined) {
    if (!TASK_STATUSES.includes(raw.status as TaskStatus)) {
      return badRequest(
        `\`status\` must be one of: ${TASK_STATUSES.join(", ")}`,
      );
    }
    patch.status = raw.status as TaskStatus;
  }
  if (raw.priority !== undefined) {
    if (typeof raw.priority !== "number" || !Number.isFinite(raw.priority)) {
      return badRequest("`priority` must be a number");
    }
    patch.priority = Math.trunc(raw.priority);
  }

  try {
    const task = updateTask(id, patch);
    if (!task) return notFound(`Task not found: ${id}`);
    return ok({ task });
  } catch (err) {
    return serverError((err as Error).message);
  }
}

export async function DELETE(
  _request: NextRequest,
  ctx: RouteContext,
): Promise<Response> {
  const { id } = await ctx.params;
  const deleted = deleteTask(id);
  if (!deleted) return notFound(`Task not found: ${id}`);
  return ok({ deleted: true });
}
