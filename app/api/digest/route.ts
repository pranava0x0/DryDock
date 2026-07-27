import { buildDigest, renderDigest } from "@/lib/insights/digest";
import { ok, serverError } from "@/lib/api/json";

export const runtime = "nodejs";

/**
 * GET /api/digest — the morning digest, as structured sections plus the
 * rendered iMessage body (EP-14 Spec C).
 *
 * Read-only. The briefing job composes prose around these numbers and
 * never computes one itself — a model asked to "summarize my usage" will
 * confabulate a plausible figure far more readily than it will say it
 * doesn't know.
 */
export async function GET(): Promise<Response> {
  try {
    const digest = buildDigest();
    return ok({ digest, text: renderDigest(digest) });
  } catch (err) {
    return serverError((err as Error).message);
  }
}
