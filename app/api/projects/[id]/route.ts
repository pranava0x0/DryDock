import type { NextRequest } from "next/server";
import {
  deleteProject,
  getProject,
  updateProject,
} from "@/lib/db/projects";
import { isProviderName } from "@/lib/providers";
import {
  badRequest,
  notFound,
  ok,
  serverError,
} from "@/lib/api/json";

export const runtime = "nodejs";

// Next.js 15 changed dynamic route params to a Promise. The `params` arg has
// to be awaited; if you destructure synchronously you get a runtime warning
// and the value comes back as `undefined`.
interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(
  _request: NextRequest,
  ctx: RouteContext,
): Promise<Response> {
  const { id } = await ctx.params;
  const project = getProject(id);
  if (!project) return notFound(`Project not found: ${id}`);
  return ok({ project });
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
    name?: string;
    path?: string;
    description?: string | null;
    provider?: "claude" | "gemini";
    test_command?: string | null;
  } = {};

  if (raw.name !== undefined) {
    if (typeof raw.name !== "string" || raw.name.trim() === "") {
      return badRequest("`name` must be a non-empty string");
    }
    patch.name = raw.name.trim();
  }
  if (raw.path !== undefined) {
    if (typeof raw.path !== "string" || raw.path.trim() === "") {
      return badRequest("`path` must be a non-empty string");
    }
    patch.path = raw.path.trim();
  }
  if (raw.description !== undefined) {
    if (raw.description !== null && typeof raw.description !== "string") {
      return badRequest("`description` must be a string or null");
    }
    patch.description = raw.description;
  }
  if (raw.provider !== undefined) {
    if (!isProviderName(raw.provider)) {
      return badRequest("`provider` must be 'claude' or 'gemini'");
    }
    patch.provider = raw.provider;
  }
  if (raw.test_command !== undefined) {
    if (raw.test_command === null) {
      patch.test_command = null;
    } else if (typeof raw.test_command === "string") {
      const trimmed = raw.test_command.trim();
      patch.test_command = trimmed.length > 0 ? trimmed : null;
    } else {
      return badRequest("`test_command` must be a string or null");
    }
  }

  try {
    const project = updateProject(id, patch);
    if (!project) return notFound(`Project not found: ${id}`);
    return ok({ project });
  } catch (err) {
    return serverError((err as Error).message);
  }
}

export async function DELETE(
  _request: NextRequest,
  ctx: RouteContext,
): Promise<Response> {
  const { id } = await ctx.params;
  const deleted = deleteProject(id);
  if (!deleted) return notFound(`Project not found: ${id}`);
  return ok({ deleted: true });
}
