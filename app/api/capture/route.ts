import type { NextRequest } from "next/server";
import { isBacklogSource, type BacklogSource } from "@/lib/db/backlog";
import { intakeCapture } from "@/lib/orchestrator/intake";
import { badRequest, created, ok, serverError } from "@/lib/api/json";

export const runtime = "nodejs";

/**
 * POST /api/capture — the five-second capture door (EP-12 Spec B).
 *
 * `{ text, source?, idempotency_key? }` → an **inbox** row.
 *
 * Auth is the existing middleware (Bearer `DRYDOCK_AUTH_TOKEN` /
 * Cloudflare Access / loopback), so a Shortcut needs one header and no
 * new secret exists anywhere.
 *
 * ── Fast and quiet on purpose ───────────────────────────────────────────
 * No Apple Notes push happens here. Inbox rows deliberately don't reach
 * the Note — only accepted ones do — which keeps the capture path off the
 * osascript critical section entirely. A capture from a phone at a
 * stoplight returns as soon as SQLite has the row.
 *
 * `idempotency_key` is what makes a retry safe: Siri over a flaky tunnel
 * will happily fire twice, and without a stable key that's two identical
 * rows to sweep every morning.
 */
export async function POST(request: NextRequest): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("Request body must be valid JSON");
  }
  if (typeof body !== "object" || body === null) {
    return badRequest("Request body must be an object");
  }
  const raw = body as Record<string, unknown>;

  const text = typeof raw.text === "string" ? raw.text.trim() : "";
  if (!text) return badRequest("`text` is required");
  if (text.length > 2000) {
    // Not a security boundary (auth already happened) — a guard against
    // a Shortcut accidentally POSTing a whole clipboard as one "idea".
    return badRequest("`text` must be 2000 characters or fewer");
  }

  let source: BacklogSource = "shortcut";
  if (raw.source !== undefined) {
    if (!isBacklogSource(raw.source)) {
      return badRequest("`source` is not a recognized capture source");
    }
    // 'manual' and 'apple-notes' land pre-triaged, and this endpoint is
    // reachable by anything holding the token — so it must not be able
    // to claim a source that bypasses the inbox. Those two have their
    // own routes.
    if (raw.source === "manual" || raw.source === "apple-notes") {
      return badRequest(
        "`source` must be a capture channel; use /api/backlog for manual entry",
      );
    }
    source = raw.source;
  }

  const idempotencyKey =
    typeof raw.idempotency_key === "string" && raw.idempotency_key.length > 0
      ? `capture:${raw.idempotency_key}`
      : null;

  try {
    const result = intakeCapture({
      text,
      source,
      externalId: idempotencyKey,
    });
    const payload = {
      outcome: result.outcome,
      item: result.item,
      parsed: {
        title: result.parsed.title,
        project_id: result.parsed.projectId,
        project_marker: result.parsed.projectMarker,
        priority: result.parsed.priority,
      },
      similar: result.similar,
    };
    // 200 rather than 201 for a duplicate: a retried Shortcut should read
    // as "already captured", not as a second success.
    return result.outcome === "created" ? created(payload) : ok(payload);
  } catch (err) {
    return serverError((err as Error).message);
  }
}
