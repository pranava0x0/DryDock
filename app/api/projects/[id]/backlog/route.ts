import type { NextRequest } from "next/server";
import { getProject } from "@/lib/db/projects";
import { scanProjectBacklog } from "@/lib/connectors/project-backlogs";
import { notFound, ok, serverError } from "@/lib/api/json";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/projects/[id]/backlog
 *
 * One project's own backlog file, parsed. Deliberately its own endpoint
 * rather than a field on `/api/projects`: the list page shows 30 projects,
 * and reading + parsing 30 markdown files to render a dashboard nobody has
 * expanded yet is the shape of problem this app already has elsewhere.
 * The UI fetches this only when a project's backlog is actually opened.
 *
 * Read-only. `importProjectBacklogs()` is the verb that files these into
 * the inbox; looking at a backlog must not change it.
 */
export async function GET(
  _request: NextRequest,
  ctx: RouteContext,
): Promise<Response> {
  const { id } = await ctx.params;
  const project = getProject(id);
  if (!project) return notFound(`Project not found: ${id}`);

  try {
    const scan = await scanProjectBacklog(project);
    return ok({ backlog: scan });
  } catch (err) {
    return serverError((err as Error).message);
  }
}
