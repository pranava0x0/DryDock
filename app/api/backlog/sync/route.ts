import type { NextRequest } from "next/server";
import {
  getNotesTitle,
  setNotesTitle,
  syncWithAppleNotes,
} from "@/lib/orchestrator/backlog";
import { badRequest, ok, serverError } from "@/lib/api/json";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  return ok({ notesTitle: getNotesTitle() });
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
    return ok({ stats });
  } catch (err) {
    return serverError((err as Error).message);
  }
}
