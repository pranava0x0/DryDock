import type { NextRequest } from "next/server";
import { getGithubWork } from "@/lib/connectors/github-work";
import { importGithubIssues } from "@/lib/connectors/github-issues-intake";
import { ok, serverError } from "@/lib/api/json";

export const runtime = "nodejs";

/**
 * GET /api/backlog/github — open PRs and issues, for the backlog screen.
 *
 * `?import=1` additionally files any open issue not already in the
 * backlog. Read and import are separate verbs on purpose: the read runs
 * on every page load, and a backlog that grows just because you looked at
 * it is a backlog you stop trusting.
 *
 * Never 500s on a `gh` problem — an unauthenticated or missing CLI comes
 * back as `status: "unavailable"` with a reason the UI can render, because
 * an empty list would read as "you have nothing open".
 */
export async function GET(request: NextRequest): Promise<Response> {
  const url = new URL(request.url);
  const force = url.searchParams.get("force") === "1";
  const shouldImport = url.searchParams.get("import") === "1";

  try {
    const work = await getGithubWork(force);
    const imported = shouldImport ? await importGithubIssues(work) : null;
    return ok({ ...work, imported });
  } catch (err) {
    return serverError((err as Error).message);
  }
}
