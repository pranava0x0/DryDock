import type { NextRequest } from "next/server";
import {
  QUOTA_WINDOWS,
  recordQuotaSnapshot,
  type QuotaWindow,
} from "@/lib/db/quota";
import type { UsageProvider } from "@/lib/db/usage";
import { badRequest, created, serverError } from "@/lib/api/json";

export const runtime = "nodejs";

const PROVIDERS: readonly UsageProvider[] = ["claude", "codex", "google"];

/**
 * POST /api/usage/observations — record a quota reading a human saw
 * (EP-15 Spec B).
 *
 * ── The ToS boundary, and why this endpoint is shaped this way ──────────
 * Anthropic's consumer terms explicitly prohibit accessing claude.ai
 * "through automated or non-human means", OpenAI's carry an equivalent
 * clause, and both are enforced. So DryDock does **no scheduled scraping
 * of chat surfaces, ever**. What remains legitimate is a human looking at
 * their own account page and telling DryDock what it said — which is what
 * this endpoint is for.
 *
 * `source` is therefore restricted to `manual` and `browser`, and
 * `browser` is reserved for a user-initiated, one-shot read of an
 * already-open page — never a cron. The absence of an automated path is
 * the feature.
 *
 * Every reading is stored with its capture time and rendered with its
 * age, because a percentage typed in on Monday must not read as current
 * on Thursday.
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

  if (
    typeof raw.provider !== "string" ||
    !(PROVIDERS as readonly string[]).includes(raw.provider)
  ) {
    return badRequest(`\`provider\` must be one of: ${PROVIDERS.join(", ")}`);
  }
  if (
    typeof raw.window !== "string" ||
    !(QUOTA_WINDOWS as readonly string[]).includes(raw.window)
  ) {
    return badRequest(`\`window\` must be one of: ${QUOTA_WINDOWS.join(", ")}`);
  }

  let usedPct: number | null = null;
  if (raw.used_pct !== undefined && raw.used_pct !== null) {
    if (
      typeof raw.used_pct !== "number" ||
      !Number.isFinite(raw.used_pct) ||
      raw.used_pct < 0 ||
      raw.used_pct > 100
    ) {
      return badRequest("`used_pct` must be a number between 0 and 100");
    }
    usedPct = raw.used_pct;
  }

  let resetsAt: number | null = null;
  if (raw.resets_at !== undefined && raw.resets_at !== null) {
    if (typeof raw.resets_at !== "number" || !Number.isFinite(raw.resets_at)) {
      return badRequest("`resets_at` must be a Unix timestamp in seconds");
    }
    resetsAt = Math.trunc(raw.resets_at);
  }

  // Only human-in-the-loop sources. `app-server` and `stats-cache` are
  // written by their own collectors and must not be claimable over HTTP,
  // or a caller could forge a reading that looks machine-verified.
  const source =
    raw.source === "browser" ? ("browser" as const) : ("manual" as const);

  try {
    const snapshot = recordQuotaSnapshot({
      provider: raw.provider as UsageProvider,
      window: raw.window as QuotaWindow,
      used_pct: usedPct,
      resets_at: resetsAt,
      source,
    });
    return created({ snapshot });
  } catch (err) {
    return serverError((err as Error).message);
  }
}
