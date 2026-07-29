import { describe, it, expect } from "vitest";
import { buildAgentPrompt, synthesizeSessionTitle } from "./prompt";

describe("buildAgentPrompt", () => {
  it("joins title and description with a blank line", () => {
    const out = buildAgentPrompt({
      title: "Fix login",
      description: "OAuth flow is broken.",
    });
    expect(out).toBe("Fix login\n\nOAuth flow is broken.");
  });

  it("returns just the title when description is empty", () => {
    const out = buildAgentPrompt({ title: "Just the title", description: "" });
    expect(out).toBe("Just the title");
  });

  it("trims whitespace around both fields", () => {
    const out = buildAgentPrompt({
      title: "  Title  ",
      description: "  body  \n",
    });
    expect(out).toBe("Title\n\nbody");
  });

  it("handles a description that is all whitespace", () => {
    const out = buildAgentPrompt({
      title: "Title",
      description: "    \n  ",
    });
    expect(out).toBe("Title");
  });
});

describe("synthesizeSessionTitle", () => {
  it("uses a short first line verbatim", () => {
    expect(synthesizeSessionTitle("Fix the login bug")).toBe("Fix the login bug");
  });

  it("takes only the first line of a multiline prompt", () => {
    expect(
      synthesizeSessionTitle("Fix the login bug\n\nIt breaks when tokens expire."),
    ).toBe("Fix the login bug");
  });

  it("skips leading blank lines", () => {
    expect(synthesizeSessionTitle("\n\n  Fix it\nmore detail")).toBe("Fix it");
  });

  it("collapses internal whitespace", () => {
    expect(synthesizeSessionTitle("Fix   the\t\tbug")).toBe("Fix the bug");
  });

  it("truncates long lines to 60 chars ending in an ellipsis", () => {
    const out = synthesizeSessionTitle("a".repeat(80));
    expect(out.length).toBe(60);
    expect(out.endsWith("…")).toBe(true);
  });

  it("returns an empty string for all-whitespace input (route rejects it first)", () => {
    expect(synthesizeSessionTitle("  \n  ")).toBe("");
  });
});
