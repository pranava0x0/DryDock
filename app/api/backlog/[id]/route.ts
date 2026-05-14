import type { NextRequest } from "next/server";
import {
  BACKLOG_STATUSES,
  type BacklogStatus,
  deleteBacklogItem,
  getBacklogItem,
  updateBacklogItem,
} from "@/lib/db/backlog";
import { pushToAppleNotesSilently } from "@/lib/orchestrator/backlog";
import { badRequest, notFound, ok, serverError } from "@/lib/api/json";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(
  _request: NextRequest,
  ctx: RouteContext,
): Promise<Response> {
  const { id } = await ctx.params;
  const item = getBacklogItem(id);
  if (!item) return notFound(`Backlog item not found: ${id}`);
  return ok({ item });
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
    description?: string | null;
    project_id?: string | null;
    status?: BacklogStatus;
    priority?: number;
  } = {};

  if (raw.title !== undefined) {
    if (typeof raw.title !== "string" || raw.title.trim() === "") {
      return badRequest("`title` must be a non-empty string");
    }
    patch.title = raw.title.trim();
  }
  if (raw.description !== undefined) {
    if (raw.description !== null && typeof raw.description !== "string") {
      return badRequest("`description` must be a string or null");
    }
    patch.description = raw.description;
  }
  if (raw.project_id !== undefined) {
    if (raw.project_id !== null && typeof raw.project_id !== "string") {
      return badRequest("`project_id` must be a string or null");
    }
    patch.project_id = raw.project_id;
  }
  if (raw.status !== undefined) {
    if (!BACKLOG_STATUSES.includes(raw.status as BacklogStatus)) {
      return badRequest(
        `\`status\` must be one of: ${BACKLOG_STATUSES.join(", ")}`,
      );
    }
    patch.status = raw.status as BacklogStatus;
  }
  if (raw.priority !== undefined) {
    if (typeof raw.priority !== "number" || !Number.isFinite(raw.priority)) {
      return badRequest("`priority` must be a number");
    }
    patch.priority = Math.trunc(raw.priority);
  }

  try {
    const item = updateBacklogItem(id, patch);
    if (!item) return notFound(`Backlog item not found: ${id}`);
    void pushToAppleNotesSilently();
    return ok({ item });
  } catch (err) {
    return serverError((err as Error).message);
  }
}

export async function DELETE(
  _request: NextRequest,
  ctx: RouteContext,
): Promise<Response> {
  const { id } = await ctx.params;
  const deleted = deleteBacklogItem(id);
  if (!deleted) return notFound(`Backlog item not found: ${id}`);
  void pushToAppleNotesSilently();
  return ok({ deleted: true });
}
