import { nanoid } from "nanoid";
import type { ProviderName } from "../providers/types";

export const ROUTING_RULES_KEY = "routing_rules";

export const CLAUDE_MODELS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "claude-haiku-4-5-20251001", label: "Haiku 4.5 — fast / cheap" },
  { value: "claude-sonnet-4-6", label: "Sonnet 4.6 — balanced" },
  { value: "claude-opus-4-7", label: "Opus 4.7 — most capable" },
];

export interface RoutingRule {
  id: string;
  label: string;
  pattern: string;
  patternType: "substring" | "regex";
  provider: ProviderName;
  /** Null means "use the provider's default model". Only meaningful for claude. */
  model: string | null;
  enabled: boolean;
}

export interface RouteMatch {
  provider: ProviderName;
  model: string | null;
  ruleId: string;
  ruleLabel: string;
}

/**
 * Walk `rules` in order and return the first match against `prompt`.
 * Returns null when no enabled rule matches.
 */
export function matchRoute(
  prompt: string,
  rules: RoutingRule[],
): RouteMatch | null {
  const lower = prompt.toLowerCase();
  for (const rule of rules) {
    if (!rule.enabled) continue;
    let matched = false;
    try {
      matched =
        rule.patternType === "regex"
          ? new RegExp(rule.pattern, "i").test(prompt)
          : lower.includes(rule.pattern.toLowerCase());
    } catch {
      // Invalid regex — skip rule rather than crashing the dispatcher.
      continue;
    }
    if (matched) {
      return {
        provider: rule.provider,
        model: rule.model,
        ruleId: rule.id,
        ruleLabel: rule.label,
      };
    }
  }
  return null;
}

/** Deserialise the JSON blob stored in `settings.routing_rules`. */
export function parseRules(json: string | null): RoutingRule[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidRule);
  } catch {
    return [];
  }
}

function isValidRule(r: unknown): r is RoutingRule {
  if (typeof r !== "object" || r === null) return false;
  const obj = r as Record<string, unknown>;
  return (
    typeof obj.id === "string" &&
    typeof obj.label === "string" &&
    typeof obj.pattern === "string" &&
    (obj.patternType === "substring" || obj.patternType === "regex") &&
    (obj.provider === "claude" || obj.provider === "gemini") &&
    (obj.model === null || typeof obj.model === "string") &&
    typeof obj.enabled === "boolean"
  );
}

export function createRule(input: Omit<RoutingRule, "id">): RoutingRule {
  return { ...input, id: nanoid() };
}
