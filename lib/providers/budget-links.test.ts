import { describe, expect, it } from "vitest";
import { PROVIDER_BUDGET_LINKS } from "./budget-links";

describe("PROVIDER_BUDGET_LINKS", () => {
  it("covers the three providers the UI promises", () => {
    const keys = PROVIDER_BUDGET_LINKS.map((p) => p.key).sort();
    expect(keys).toEqual(["claude", "codex", "google"]);
  });

  it("has unique keys (React list keys depend on this)", () => {
    const keys = PROVIDER_BUDGET_LINKS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it.each(PROVIDER_BUDGET_LINKS)(
    "$key: url uses https and contains the declared host",
    (entry) => {
      // Prevents accidentally shipping a plain-http URL (would be flagged
      // by Safari's mixed-content protections from the PWA) and catches
      // typos where the visible host text drifts from the actual URL.
      expect(entry.url).toMatch(/^https:\/\//);
      expect(entry.url).toContain(entry.host);
    },
  );

  it.each(PROVIDER_BUDGET_LINKS)("$key: label is non-empty", (entry) => {
    expect(entry.label.trim().length).toBeGreaterThan(0);
  });
});
