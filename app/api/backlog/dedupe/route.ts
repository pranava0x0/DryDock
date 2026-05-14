import {
  dedupeBacklogItems,
  pushToAppleNotesSilently,
} from "@/lib/orchestrator/backlog";
import { ok, serverError } from "@/lib/api/json";

export const runtime = "nodejs";

/**
 * Collapse same-title duplicate backlog rows. After the DB cleanup we
 * push to Apple Notes silently so the user's note reflects the
 * consolidated state immediately — otherwise the note would still
 * show duplicates until the next manual sync.
 */
export async function POST(): Promise<Response> {
  try {
    const report = dedupeBacklogItems();
    const push = await pushToAppleNotesSilently();
    return ok({ report, notesPush: push });
  } catch (err) {
    return serverError((err as Error).message);
  }
}
