import type { NextRequest } from "next/server";
import { importUsageExport, type ExportFormat } from "@/lib/connectors/usage-imports";
import { badRequest, ok, serverError } from "@/lib/api/json";

export const runtime = "nodejs";

/** Bounded so a 500MB export can't be pulled into memory whole. */
const MAX_BYTES = 64 * 1024 * 1024;

/**
 * POST /api/usage/import — an official data export → `surface='web'`
 * ledger rows (EP-15 Spec A).
 *
 * Body is the export JSON itself. This is the *reliable, zero-ToS-risk*
 * path for web-chat usage: the user runs the provider's own export, drops
 * the file here, and gets real numbers with a stated freshness rather
 * than a scrape that would violate the consumer terms.
 *
 * Idempotent — re-importing an overlapping export overwrites the same
 * primary keys rather than doubling them.
 */
export async function POST(request: NextRequest): Promise<Response> {
  const url = new URL(request.url);
  const formatParam = url.searchParams.get("format");
  const format =
    formatParam === "chatgpt" || formatParam === "gemini" || formatParam === "claude"
      ? (formatParam as ExportFormat)
      : undefined;

  const declared = Number.parseInt(
    request.headers.get("content-length") ?? "0",
    10,
  );
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    return badRequest(
      `Export is larger than ${Math.round(MAX_BYTES / 1024 / 1024)}MB`,
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("Request body must be the export's JSON");
  }

  try {
    const result = importUsageExport(body, format);
    // A parse that recognized nothing is a 400, not a silent success —
    // otherwise the user drops the wrong file and sees "0 rows" without
    // learning why.
    if (result.reason) return badRequest(result.reason);
    return ok({ imported: result });
  } catch (err) {
    return serverError((err as Error).message);
  }
}
