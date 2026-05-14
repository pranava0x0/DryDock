import { describe, it, expect } from "vitest";
import { buildAgentPrompt } from "./prompt";

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
