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

  // DD-BL-37. Every link originally pointed at its provider's *API*
  // console, which is a different product from the subscription the card
  // reports on — so "check my usage" landed on a page showing zero. Pin
  // the consumer targets exactly; a drift back to a developer console is
  // a silent wrong answer, not a cosmetic change.
  it("points at consumer surfaces, not developer/API consoles", () => {
    const byKey = Object.fromEntries(
      PROVIDER_BUDGET_LINKS.map((e) => [e.key, e.url]),
    );
    expect(byKey.claude).toBe("https://claude.ai/settings/usage");
    expect(byKey.codex).toBe("https://chatgpt.com/codex/settings/usage");
    expect(byKey.google).toBe("https://one.google.com/settings");
  });

  it.each(PROVIDER_BUDGET_LINKS)(
    "$key: url is not an API/developer console",
    (entry) => {
      // The specific hosts that burned us. Kept as a separate assertion
      // from the exact-URL pin above so the failure message names the
      // actual mistake if someone edits a path and reintroduces one.
      expect(entry.url).not.toMatch(
        /console\.anthropic\.com|platform\.claude\.com|platform\.openai\.com/,
      );
    },
  );
});
