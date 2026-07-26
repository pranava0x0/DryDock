import type { NextRequest } from "next/server";
import {
  getTrackerRepo,
  setTrackerRepo,
  syncGithubMirror,
} from "@/lib/orchestrator/github-mirror";
import {
  createTrackerRepo,
  isValidRepo,
} from "@/lib/integrations/github-issues";
import { badRequest, ok, serverError } from "@/lib/api/json";

export const runtime = "nodejs";

/** GET — current tracker repo. */
export async function GET(): Promise<Response> {
  try {
    return ok({ repo: getTrackerRepo() });
  } catch (err) {
    return serverError((err as Error).message);
  }
}

/**
 * POST — set the tracker repo, optionally create it, and run a sync.
 *
 * `{ repo?: "owner/name", create?: true, sync?: true }`
 *
 * Creating a repo is an outward-facing action, so it only happens when
 * the caller explicitly asks for it — never as a side effect of saving
 * the setting.
 */
export async function POST(request: NextRequest): Promise<Response> {
  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    // An empty body means "just sync with what's configured".
  }
  const raw = (body ?? {}) as Record<string, unknown>;

  try {
    if (raw.repo !== undefined) {
      if (raw.repo === null || raw.repo === "") {
        setTrackerRepo(null);
        return ok({ repo: null, synced: null });
      }
      if (!isValidRepo(raw.repo)) {
        return badRequest("`repo` must look like `owner/name`");
      }
      if (raw.create === true) {
        const created = await createTrackerRepo(raw.repo);
        if (!created.ok) {
          return badRequest(`Could not create ${raw.repo}: ${created.reason}`);
        }
      }
      setTrackerRepo(raw.repo);
    }

    const synced = raw.sync === false ? null : await syncGithubMirror();
    return ok({ repo: getTrackerRepo(), synced });
  } catch (err) {
    return serverError((err as Error).message);
  }
}
