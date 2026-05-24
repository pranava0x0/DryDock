import { describe, it, expect } from "vitest";
import { matchRoute, parseRules, createRule } from "./rules";
import type { RoutingRule } from "./rules";

const base: Omit<RoutingRule, "id"> = {
  label: "Lint fix",
  pattern: "fix lint",
  patternType: "substring",
  provider: "claude",
  model: "claude-haiku-4-5-20251001",
  enabled: true,
};

// ─── matchRoute ────────────────────────────────────────────────────────────

describe("matchRoute", () => {
  it("matches substring (case-insensitive)", () => {
    const result = matchRoute("Please fix lint errors", [createRule(base)]);
    expect(result).not.toBeNull();
    expect(result!.provider).toBe("claude");
    expect(result!.model).toBe("claude-haiku-4-5-20251001");
    expect(result!.ruleLabel).toBe("Lint fix");
  });

  it("is case-insensitive for substring matching", () => {
    expect(matchRoute("FIX LINT now", [createRule(base)])).not.toBeNull();
    expect(matchRoute("Fix Lint Now", [createRule(base)])).not.toBeNull();
  });

  it("returns null when no rule matches", () => {
    expect(matchRoute("refactor auth module", [createRule(base)])).toBeNull();
  });

  it("returns null for empty rules array", () => {
    expect(matchRoute("fix lint", [])).toBeNull();
  });

  it("skips disabled rules", () => {
    const rule = createRule({ ...base, enabled: false });
    expect(matchRoute("fix lint everything", [rule])).toBeNull();
  });

  it("first-match-wins — returns the first matching rule", () => {
    const rules = [
      createRule({ ...base, label: "A", provider: "claude" }),
      createRule({ ...base, label: "B", provider: "gemini" }),
    ];
    const result = matchRoute("fix lint errors", rules);
    expect(result!.ruleLabel).toBe("A");
  });

  it("skips disabled rule and falls through to next match", () => {
    const rules = [
      createRule({ ...base, label: "A", enabled: false }),
      createRule({ ...base, label: "B", provider: "gemini" }),
    ];
    const result = matchRoute("fix lint errors", rules);
    expect(result!.ruleLabel).toBe("B");
  });

  it("matches regex pattern", () => {
    const rule = createRule({
      ...base,
      pattern: "refactor\\s+\\w+",
      patternType: "regex",
    });
    expect(matchRoute("refactor auth now", [rule])).not.toBeNull();
  });

  it("regex match is case-insensitive via the i flag", () => {
    const rule = createRule({
      ...base,
      pattern: "refactor",
      patternType: "regex",
    });
    expect(matchRoute("REFACTOR auth", [rule])).not.toBeNull();
  });

  it("skips invalid regex without throwing", () => {
    const rule = createRule({
      ...base,
      pattern: "(unclosed",
      patternType: "regex",
    });
    expect(() => matchRoute("any prompt", [rule])).not.toThrow();
    expect(matchRoute("any prompt", [rule])).toBeNull();
  });

  it("exposes ruleId in the match result", () => {
    const rule = createRule(base);
    const result = matchRoute("fix lint", [rule]);
    expect(result!.ruleId).toBe(rule.id);
  });

  it("model can be null", () => {
    const rule = createRule({ ...base, model: null });
    const result = matchRoute("fix lint", [rule]);
    expect(result!.model).toBeNull();
  });
});

// ─── parseRules ────────────────────────────────────────────────────────────

describe("parseRules", () => {
  it("returns empty array for null", () => {
    expect(parseRules(null)).toEqual([]);
  });

  it("returns empty array for invalid JSON", () => {
    expect(parseRules("{bad")).toEqual([]);
  });

  it("returns empty array for non-array JSON", () => {
    expect(parseRules('{"not":"array"}')).toEqual([]);
  });

  it("filters out malformed rules", () => {
    const valid = createRule(base);
    const raw = JSON.stringify([valid, { id: "bad", label: 123 }]);
    const result = parseRules(raw);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(valid.id);
  });

  it("returns all valid rules", () => {
    const rules = [createRule(base), createRule({ ...base, label: "B" })];
    expect(parseRules(JSON.stringify(rules))).toHaveLength(2);
  });
});
