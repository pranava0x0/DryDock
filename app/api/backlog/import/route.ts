import { importProjectBacklogs } from "@/lib/connectors/project-backlogs";
import { ok, serverError } from "@/lib/api/json";

export const runtime = "nodejs";

/**
 * POST /api/backlog/import — pull every project's own backlog.md into
 * the inbox.
 *
 * POST, not GET, and never automatic: reading a dozen repos' backlog
 * files can produce a lot of rows, so it's an action the user takes
 * deliberately and can see the result of. Idempotent — each line carries
 * a `projfile:<projectId>:<slug>` external id, so re-running refreshes
 * instead of duplicating.
 */
export async function POST(): Promise<Response> {
  try {
    const results = await importProjectBacklogs();
    const totals = results.reduce(
      (acc, r) => ({
        created: acc.created + r.created,
        updated: acc.updated + r.updated,
        duplicates: acc.duplicates + r.duplicates,
        skipped: acc.skipped + r.skipped,
      }),
      { created: 0, updated: 0, duplicates: 0, skipped: 0 },
    );
    return ok({ results, totals });
  } catch (err) {
    return serverError((err as Error).message);
  }
}
