import type { NextRequest } from "next/server";
import { getSetting, setSetting } from "@/lib/db/settings";
import {
  parseRules,
  createRule,
  ROUTING_RULES_KEY,
  type RoutingRule,
} from "@/lib/routing/rules";
import { isProviderName } from "@/lib/providers/types";
import { badRequest, ok, serverError } from "@/lib/api/json";

export const runtime = "nodejs";

function loadRules(): RoutingRule[] {
  return parseRules(getSetting(ROUTING_RULES_KEY));
}

function saveRules(rules: RoutingRule[]): void {
  setSetting(ROUTING_RULES_KEY, JSON.stringify(rules));
}

function validateRule(
  r: unknown,
): { ok: true; rule: Omit<RoutingRule, "id"> } | { ok: false; error: string } {
  if (typeof r !== "object" || r === null)
    return { ok: false, error: "Rule must be an object" };
  const obj = r as Record<string, unknown>;

  if (typeof obj.label !== "string" || obj.label.trim() === "")
    return { ok: false, error: "Rule label must be a non-empty string" };
  if (typeof obj.pattern !== "string" || obj.pattern.trim() === "")
    return { ok: false, error: "Rule pattern must be a non-empty string" };
  if (obj.patternType !== "substring" && obj.patternType !== "regex")
    return { ok: false, error: "patternType must be 'substring' or 'regex'" };
  if (obj.patternType === "regex") {
    try {
      new RegExp(obj.pattern as string);
    } catch {
      return { ok: false, error: `Invalid regex: ${obj.pattern}` };
    }
  }
  if (!isProviderName(obj.provider))
    return { ok: false, error: "provider must be 'claude' or 'gemini'" };
  if (obj.model !== null && typeof obj.model !== "string")
    return { ok: false, error: "model must be a string or null" };
  if (typeof obj.enabled !== "boolean")
    return { ok: false, error: "enabled must be a boolean" };

  return {
    ok: true,
    rule: {
      label: (obj.label as string).trim(),
      pattern: (obj.pattern as string).trim(),
      patternType: obj.patternType,
      provider: obj.provider,
      model: (obj.model as string | null) ?? null,
      enabled: obj.enabled as boolean,
    },
  };
}

/** GET /api/routing-rules — return the current rule list. */
export async function GET(): Promise<Response> {
  try {
    return ok({ rules: loadRules() });
  } catch (err) {
    return serverError((err as Error).message);
  }
}

/** POST /api/routing-rules — append a new rule. Body: Omit<RoutingRule, "id"> */
export async function POST(request: NextRequest): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("Request body must be valid JSON");
  }

  const validated = validateRule(body);
  if (!validated.ok) return badRequest(validated.error);

  try {
    const rules = loadRules();
    const newRule = createRule(validated.rule);
    rules.push(newRule);
    saveRules(rules);
    return ok({ rules, rule: newRule });
  } catch (err) {
    return serverError((err as Error).message);
  }
}

/** PUT /api/routing-rules — replace the full rule list. Body: { rules: RoutingRule[] } */
export async function PUT(request: NextRequest): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("Request body must be valid JSON");
  }
  if (
    typeof body !== "object" ||
    body === null ||
    !Array.isArray((body as Record<string, unknown>).rules)
  ) {
    return badRequest("Body must be { rules: RoutingRule[] }");
  }
  const incoming = (body as { rules: unknown[] }).rules;

  const validated: RoutingRule[] = [];
  for (const item of incoming) {
    if (
      typeof item !== "object" ||
      item === null ||
      typeof (item as Record<string, unknown>).id !== "string"
    ) {
      return badRequest("Each rule must have a string id");
    }
    const check = validateRule(item);
    if (!check.ok) return badRequest(check.error);
    validated.push({
      ...(check.rule as Omit<RoutingRule, "id">),
      id: (item as { id: string }).id,
    });
  }

  try {
    saveRules(validated);
    return ok({ rules: validated });
  } catch (err) {
    return serverError((err as Error).message);
  }
}

/** DELETE /api/routing-rules?id=<id> — remove a rule by id. */
export async function DELETE(request: NextRequest): Promise<Response> {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return badRequest("Missing query param: id");
  try {
    const rules = loadRules().filter((r) => r.id !== id);
    saveRules(rules);
    return ok({ rules });
  } catch (err) {
    return serverError((err as Error).message);
  }
}
