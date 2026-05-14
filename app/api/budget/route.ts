import type { NextRequest } from "next/server";
import {
  getBudgetRollup,
  recordAlertedThreshold,
  setMonthlyBudget,
} from "@/lib/budget/rollup";
import { badRequest, ok, serverError } from "@/lib/api/json";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  try {
    return ok({ budget: getBudgetRollup() });
  } catch (err) {
    return serverError((err as Error).message);
  }
}

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

  if ("budget_usd" in raw) {
    const v = raw.budget_usd;
    if (v === null) {
      setMonthlyBudget(null);
    } else if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
      setMonthlyBudget(v);
    } else {
      return badRequest("`budget_usd` must be a non-negative number or null");
    }
  }

  // The client calls PUT with `acked_pct` after showing the user the
  // threshold-crossed banner / notification, so we don't re-alert until
  // they next cross a higher band (or until the next calendar month).
  if ("acked_pct" in raw) {
    const v = raw.acked_pct;
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
      recordAlertedThreshold(v);
    } else {
      return badRequest("`acked_pct` must be a non-negative number");
    }
  }

  try {
    return ok({ budget: getBudgetRollup() });
  } catch (err) {
    return serverError((err as Error).message);
  }
}
