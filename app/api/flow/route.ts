import type { NextRequest } from "next/server";
import { buildFlowSummary } from "@/lib/insights/flow-summary";
import { badRequest, ok, serverError } from "@/lib/api/json";

export const runtime = "nodejs";

/**
 * GET /api/flow?window=90 — the Analytics → Flow payload.
 *
 * Reads local git clones rather than the GitHub API: attribution needs
 * full commit message bodies (that's where the trailers live), private
 * repos come free, and a 34-repo sweep costs no rate limit. See
 * lib/connectors/git-flow.ts.
 *
 * `?github=1` additionally folds in open PRs and issues, which needs the
 * network — kept opt-in so the local half always renders fast.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const url = new URL(request.url);
  const windowParam = url.searchParams.get("window");
  const includeGithub = url.searchParams.get("github") === "1";

  let windowDays = 90;
  if (windowParam !== null) {
    const parsed = Number.parseInt(windowParam, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 730) {
      return badRequest("`window` must be a number of days between 1 and 730");
    }
    windowDays = parsed;
  }

  try {
    return ok(await buildFlowSummary({ windowDays, includeGithub }));
  } catch (err) {
    return serverError((err as Error).message);
  }
}
