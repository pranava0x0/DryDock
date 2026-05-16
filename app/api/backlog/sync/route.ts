import type { NextRequest } from "next/server";
import {
  getLastSyncedAt,
  getNotesTitle,
  setNotesTitle,
  syncWithAppleNotes,
} from "@/lib/orchestrator/backlog";
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
    return ok({ stats, lastSyncedAt: getLastSyncedAt() });
  } catch (err) {
    // Sync failure shouldn't crash the page — surface the underlying
    // osascript / permissions message so the UI can show a small
    // inline alert while keeping the rest of the backlog usable.
    return serverError((err as Error).message);
  }
}
