import type { NextRequest } from "next/server";
import {
  collectUsageInBackground,
  hasCollectedEver,
  isCollecting,
  usageHealth,
} from "@/lib/connectors";
import { collectQuotas } from "@/lib/connectors/quota";
import { buildUsageSummary } from "@/lib/insights/usage-summary";
import { badRequest, ok, serverError } from "@/lib/api/json";

export const runtime = "nodejs";

/**
 * GET /api/usage?window=30
 *
 * The Usage tab's one request. Collect-on-read with a TTL — the same
 * pattern `/api/provider-budgets` uses, and the reason DryDock doesn't
 * need EP-8's scheduler to keep the ledger current: whoever opens the
 * dashboard pays for a refresh, at most once a minute, shared across
 * concurrent readers by the connectors' own mutex.
 *
 * `?force=1` bypasses the TTL for an explicit "refresh now" tap. There is
 * deliberately no client-side polling attached to this route — the
 * CLAUDE.md rule against adding auto-sync triggers stands.
 *
 * A collector failure never fails the request: `collectUsage` resolves
 * every connector to a result, failures included, and those surface as
 * health chips on the affected card while the other providers render
 * normally.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const url = new URL(request.url);
  const windowParam = url.searchParams.get("window");
  const force = url.searchParams.get("force") === "1";

  let windowDays = 30;
  if (windowParam !== null) {
    const parsed = Number.parseInt(windowParam, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 730) {
      return badRequest("`window` must be a number of days between 1 and 730");
    }
    windowDays = parsed;
  }

  try {
    // The collect does NOT block the response. On this machine the first
    // walk takes ~83s (270 large Claude session logs, all recent enough
    // that the mtime pre-filter can't skip any of them), and a dashboard
    // that spins for a minute and a half is a broken dashboard —
    // especially on a phone over the tunnel. Instead: kick the walk off,
    // answer from the ledger as it stands, and tell the client whether a
    // collect is in flight so it can say "still reading your logs"
    // instead of rendering a cold ledger's zeros as fact.
    collectUsageInBackground({ force });
    // Quotas are cheap (a subprocess call and a file read) and a failure
    // there must not cost the user their token history, so it's awaited
    // but caught separately.
    await collectQuotas({ force }).catch(() => []);

    const summary = await buildUsageSummary({ windowDays });
    return ok({
      ...summary,
      collectors: await usageHealth(),
      collecting: isCollecting(),
      everCollected: await hasCollectedEver(),
    });
  } catch (err) {
    return serverError((err as Error).message);
  }
}
