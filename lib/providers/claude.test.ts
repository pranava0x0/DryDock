import { describe, expect, it } from "vitest";
import {
  autonomyArgs,
  buildClaudeArgs,
  EDITS_BASH_ALLOWLIST,
} from "./claude";

describe("autonomyArgs", () => {
  it("readonly maps to plan mode with no tool grants", () => {
    expect(autonomyArgs("readonly")).toEqual(["--permission-mode", "plan"]);
  });

  it("edits maps to acceptEdits plus the narrow Bash allowlist", () => {
    const args = autonomyArgs("edits");
    expect(args.slice(0, 2)).toEqual(["--permission-mode", "acceptEdits"]);
    expect(args[2]).toBe("--allowedTools");
    expect(args[3]).toBe(EDITS_BASH_ALLOWLIST.join(","));
  });

  it("defaults to edits when no level is given", () => {
    expect(autonomyArgs()).toEqual(autonomyArgs("edits"));
  });

  it("full grants unrestricted Bash under acceptEdits", () => {
    expect(autonomyArgs("full")).toEqual([
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      "Bash",
    ]);
  });

  it("never emits a permission bypass at any level", () => {
    for (const level of ["readonly", "edits", "full"] as const) {
      expect(autonomyArgs(level)).not.toContain(
        "--dangerously-skip-permissions",
      );
    }
  });

  it("edits allowlist stays read-only-git + test/build commands", () => {
    // Regression pin: nothing in the allowlist may mutate git state or the
    // network. If this fails, someone widened the default blast radius.
    for (const rule of EDITS_BASH_ALLOWLIST) {
      expect(rule).toMatch(/^Bash\((npm (test|run (test|typecheck|build)):\*|git (status|diff|log):\*)\)$/);
    }
  });
});

describe("buildClaudeArgs", () => {
  it("keeps the prompt as the final argv element", () => {
    // Guard against the variadic --allowedTools form swallowing the prompt.
    const args = buildClaudeArgs("fix the bug", { autonomy: "edits" });
    expect(args[args.length - 1]).toBe("fix the bug");
  });

  it("passes --allowedTools as a single comma-joined element", () => {
    const args = buildClaudeArgs("p", { autonomy: "edits" });
    const idx = args.indexOf("--allowedTools");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toContain(",");
    // The element after the allowlist must be the next flag or the prompt,
    // never a bare tool rule.
    expect(args[idx + 2]).toBe("p");
  });

  it("includes --model only when a model override is set", () => {
    expect(buildClaudeArgs("p", {})).not.toContain("--model");
    const withModel = buildClaudeArgs("p", { model: "claude-haiku-4-5" });
    const idx = withModel.indexOf("--model");
    expect(withModel[idx + 1]).toBe("claude-haiku-4-5");
    expect(withModel[withModel.length - 1]).toBe("p");
  });

  it("always runs headless stream-json", () => {
    const args = buildClaudeArgs("p", { autonomy: "full" });
    expect(args.slice(0, 4)).toEqual([
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
    ]);
  });
});
