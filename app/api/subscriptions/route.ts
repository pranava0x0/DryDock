import type { NextRequest } from "next/server";
import {
  listSubscriptions,
  upsertSubscription,
} from "@/lib/db/subscriptions";
import type { UsageProvider } from "@/lib/db/usage";
import { badRequest, conflict, ok, serverError } from "@/lib/api/json";

export const runtime = "nodejs";

const PROVIDERS: readonly UsageProvider[] = ["claude", "codex", "google"];

function isProvider(value: unknown): value is UsageProvider {
  return (
    typeof value === "string" &&
    (PROVIDERS as readonly string[]).includes(value)
  );
}

export async function GET(): Promise<Response> {
  try {
    return ok({ subscriptions: listSubscriptions() });
  } catch (err) {
    return serverError((err as Error).message);
  }
}

/**
 * PUT /api/subscriptions — write one provider's plan facts.
 *
 * Always writes with `source='manual'`: this route is the *user's* entry
 * point, and manual entry is the top of the precedence order. Collectors
 * (EP-15) write through their own path and can't reach this one, so a
 * scraper can never masquerade as something the user typed.
 */
export async function PUT(request: NextRequest): Promise<Response> {
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

  if (!isProvider(raw.provider)) {
    return badRequest(`\`provider\` must be one of: ${PROVIDERS.join(", ")}`);
  }

  const plan_name = optionalString(raw.plan_name);
  if (plan_name === INVALID) return badRequest("`plan_name` must be a string or null");

  const price = optionalNumber(raw.price_usd_month);
  if (price === INVALID) {
    return badRequest("`price_usd_month` must be a non-negative number or null");
  }

  const renewal = optionalNumber(raw.renewal_day);
  if (renewal === INVALID) {
    return badRequest("`renewal_day` must be a number or null");
  }
  if (typeof renewal === "number" && (renewal < 1 || renewal > 31)) {
    return badRequest("`renewal_day` must be between 1 and 31");
  }

  const cap_notes = optionalString(raw.cap_notes);
  if (cap_notes === INVALID) return badRequest("`cap_notes` must be a string or null");

  try {
    const result = upsertSubscription(raw.provider, {
      ...(plan_name !== undefined ? { plan_name } : {}),
      ...(price !== undefined ? { price_usd_month: price } : {}),
      ...(renewal !== undefined
        ? { renewal_day: renewal === null ? null : Math.trunc(renewal) }
        : {}),
      ...(cap_notes !== undefined ? { cap_notes } : {}),
      source: "manual",
    });
    if (!result.written) {
      // Unreachable today (manual always wins), but returning a 409
      // rather than a silent 200 keeps the precedence rule visible if the
      // source ever becomes caller-supplied.
      return conflict("A higher-precedence source owns this subscription row");
    }
    return ok({ subscription: result.subscription });
  } catch (err) {
    return serverError((err as Error).message);
  }
}

/** Sentinel for "present but the wrong type", distinct from absent/null. */
const INVALID = Symbol("invalid");

function optionalString(
  value: unknown,
): string | null | undefined | typeof INVALID {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") return INVALID;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function optionalNumber(
  value: unknown,
): number | null | undefined | typeof INVALID {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return INVALID;
  }
  return value;
}
