import type { NextRequest } from "next/server";
import {
  BACKLOG_STATUSES,
  type BacklogStatus,
  createBacklogItem,
  listBacklog,
} from "@/lib/db/backlog";
import { pushToAppleNotesSilently } from "@/lib/orchestrator/backlog";
import { badRequest, created, ok, serverError } from "@/lib/api/json";

export const runtime = "nodejs";

export async function GET(request: NextRequest): Promise<Response> {
  const url = new URL(request.url);
  const statusParam = url.searchParams.get("status");
  const projectIdParam = url.searchParams.get("projectId");

  let status: BacklogStatus | undefined;
  if (statusParam) {
    if (!BACKLOG_STATUSES.includes(statusParam as BacklogStatus)) {
      return badRequest(
        `\`status\` must be one of: ${BACKLOG_STATUSES.join(", ")}`,
      );
    }
    status = statusParam as BacklogStatus;
  }

  try {
    const items = listBacklog({
      status,
      projectId: projectIdParam ?? undefined,
    });
    return ok({ items });
  } catch (err) {
    return serverError((err as Error).message);
  }
}

export async function POST(request: NextRequest): Promise<Response> {
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

  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (!title) return badRequest("`title` is required");

  const description =
    typeof raw.description === "string" ? raw.description : null;
  const project_id = typeof raw.project_id === "string" ? raw.project_id : null;

  let priority = 0;
  if (raw.priority !== undefined) {
    if (typeof raw.priority !== "number" || !Number.isFinite(raw.priority)) {
      return badRequest("`priority` must be a number");
    }
    priority = Math.trunc(raw.priority);
  }

  try {
    const item = createBacklogItem({
      title,
      description,
      project_id,
      priority,
    });
    // Fire-and-forget Apple Notes push so the note stays in sync without
    // blocking the API. Errors are swallowed inside the helper.
    void pushToAppleNotesSilently();
    return created({ item });
  } catch (err) {
    return serverError((err as Error).message);
  }
}
