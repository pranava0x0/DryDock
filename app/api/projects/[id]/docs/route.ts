import type { NextRequest } from "next/server";
import { getProject } from "@/lib/db/projects";
import { readProjectDocs } from "@/lib/discovery/scan";
import { notFound, ok, serverError } from "@/lib/api/json";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Return the small set of "what's happening in this project" docs
 * (issues.md, backlog.md, CLAUDE.md, etc.) inline so the UI can render
 * them as collapsible cards without a per-file follow-up fetch.
 *
 * Each doc is capped at 256 KB (see DOC_MAX_BYTES in scan.ts) so a
 * malformed file in a user's project can't blow up the response.
 */
export async function GET(
  _request: NextRequest,
  ctx: RouteContext,
): Promise<Response> {
  const { id } = await ctx.params;
  const project = getProject(id);
  if (!project) return notFound(`Project not found: ${id}`);

  try {
    const docs = await readProjectDocs(project.path);
    return ok({ project, docs });
  } catch (err) {
    return serverError((err as Error).message);
  }
}
