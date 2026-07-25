import { triageBacklogItem } from "@/lib/db/backlog";
import { pushToAppleNotesSilently } from "@/lib/orchestrator/backlog";
import { notFound, ok, serverError } from "@/lib/api/json";

export const runtime = "nodejs";

/**
 * POST /api/backlog/[id]/triage — accept an inbox item into the trusted
 * backlog.
 *
 * This is the moment an item becomes real: it starts appearing in the
 * default backlog list, it gets pushed to the Apple Note, and (EP-13)
 * it gets mirrored to the tracker repo. Everything upstream of this —
 * Siri, iMessage, project files, the idea generator — can only ever put
 * something in front of the user, never into the list itself.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  try {
    const item = triageBacklogItem(id);
    if (!item) return notFound(`Backlog item not found: ${id}`);
    // Now that it's trusted, it belongs in the Note. Fire-and-forget so
    // an Apple Notes permission problem can't block the accept.
    void pushToAppleNotesSilently();
    return ok({ item });
  } catch (err) {
    return serverError((err as Error).message);
  }
}
