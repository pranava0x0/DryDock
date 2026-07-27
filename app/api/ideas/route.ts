import type { NextRequest } from "next/server";
import { archiveStaleProposals, importIdeas } from "@/lib/connectors/ideas-folder";
import { ok, serverError } from "@/lib/api/json";

export const runtime = "nodejs";

/**
 * POST /api/ideas — pull the nightly idea generator's specs into the
 * inbox as `proposed` rows (EP-14 Spec B).
 *
 * This is the *fallback* path. The primary route is the ideas skill
 * calling `add_backlog_item` over MCP as it writes each spec; both land
 * identically, so running this as well is harmless.
 *
 * POST rather than GET, and never automatic, for the same reason as the
 * project-backlog import: a queue that grows because you looked at it is
 * a queue you stop opening.
 *
 * `?archive=1` also drops proposals nobody accepted within 30 days. The
 * spec files stay on disk, so a re-import brings back anything archived
 * in error.
 */
export async function POST(request: NextRequest): Promise<Response> {
  const url = new URL(request.url);
  const shouldArchive = url.searchParams.get("archive") === "1";
  try {
    const imported = await importIdeas();
    const archived = shouldArchive ? archiveStaleProposals() : 0;
    return ok({ ...imported, archived });
  } catch (err) {
    return serverError((err as Error).message);
  }
}
