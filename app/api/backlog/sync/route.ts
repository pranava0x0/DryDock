import type { NextRequest } from "next/server";
import {
  getLastSyncedAt,
  getNotesTitle,
  setNotesTitle,
  syncWithAppleNotes,
} from "@/lib/orchestrator/backlog";
import { syncGithubMirror } from "@/lib/orchestrator/github-mirror";
import { badRequest, ok, serverError } from "@/lib/api/json";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  // Surface last-sync-at so the client-side SyncStatus badge can
  // render "Synced 30s ago" without firing an actual sync — useful
  // for pages that don't want to trigger osascript on every mount.
  return ok({
    notesTitle: getNotesTitle(),
    lastSyncedAt: getLastSyncedAt(),
  });
}

/**
 * Trigger a bidirectional sync with Apple Notes. Optionally update the
 * configured note title (`{ notesTitle: "..." }`) before syncing — that
 * lets the user point DryDock at a differently-named note without
 * editing the DB by hand.
 */
export async function POST(request: NextRequest): Promise<Response> {
  let body: unknown = {};
  try {
    body = await request.json().catch(() => ({}));
  } catch {
    // ignore — caller may have sent an empty body
  }
  if (body && typeof body === "object") {
    const raw = body as Record<string, unknown>;
    if (raw.notesTitle !== undefined) {
      if (typeof raw.notesTitle !== "string" || raw.notesTitle.trim() === "") {
        return badRequest("`notesTitle` must be a non-empty string");
      }
      setNotesTitle(raw.notesTitle.trim());
    }
  }

  try {
    const stats = await syncWithAppleNotes();

    // The GitHub mirror runs in the SAME tick, right after Notes.
    //
    // It was previously reachable only from the Settings page, which
    // made it a one-time snapshot: every later create, edit, complete,
    // or reopen left the tracker stale until the user went back to
    // Settings and hit Save again — the opposite of the "zero clicks
    // added to the daily flow" it promised. (Codex P1 on PR #8.)
    //
    // Sequential, not parallel, and deliberately so: both spokes mutate
    // the same rows, so running them concurrently would introduce a race
    // class that neither has today. Notes first because it's the older,
    // more load-bearing surface.
    //
    // A mirror failure must not fail the Notes sync — an unauthenticated
    // `gh` or a missing tracker repo is an ordinary state, and the
    // backlog page has to keep working through it.
    const mirror = await syncGithubMirror().catch((err: Error) => ({
      repo: null,
      created: 0,
      updated: 0,
      closed: 0,
      pulledNew: 0,
      pulledUpdated: 0,
      reAdopted: 0,
      status: "unavailable" as const,
      reason: err.message,
    }));

    return ok({ stats, mirror, lastSyncedAt: getLastSyncedAt() });
  } catch (err) {
    // Sync failure shouldn't crash the page — surface the underlying
    // osascript / permissions message so the UI can show a small
    // inline alert while keeping the rest of the backlog usable.
    return serverError((err as Error).message);
  }
}
