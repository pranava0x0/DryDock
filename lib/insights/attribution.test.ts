import { describe, expect, it } from "vitest";
import {
  attributeCommit,
  extractModel,
  summarizeAttribution,
  type AttributedCommit,
} from "./attribution";

/**
 * Fixtures are copied from this user's actual repos, capitalization and
 * all — that variation is the thing most likely to break the parser.
 */
const CLAUDE_TRAILER =
  "fix: something\n\nCo-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>";
const CLAUDE_LOWER =
  "fix: something\n\nCo-authored-by: Claude Sonnet 4.6 <noreply@anthropic.com>";
const CLAUDE_CONTEXT =
  "fix: something\n\nCo-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>";
const CODEX_TRAILER =
  "fix: something\n\nCo-authored-by: Codex <noreply@openai.com>";
const HUMAN_TRAILER =
  "fix: something\n\nCo-authored-by: Pranava Raparla <pranava@pranavas-air.local>";

describe("attributeCommit — trailers", () => {
  it("reads the agent and model from a Claude trailer", () => {
    expect(attributeCommit({ message: CLAUDE_TRAILER })).toEqual({
      agent: "claude",
      model: "Opus 4.7",
      source: "trailer",
    });
  });

  it("matches case-insensitively", () => {
    // Different tool versions wrote `Co-Authored-By` and
    // `Co-authored-by`. A case-sensitive match loses a third of the data.
    expect(attributeCommit({ message: CLAUDE_LOWER }).agent).toBe("claude");
    expect(attributeCommit({ message: CLAUDE_LOWER }).model).toBe("Sonnet 4.6");
  });

  it("collapses a context-window parenthetical into the base model", () => {
    // "Opus 4.6" and "Opus 4.6 (1M context)" are the same model; two
    // legend entries would make the mix read as more fragmented than it is.
    expect(attributeCommit({ message: CLAUDE_CONTEXT }).model).toBe("Opus 4.6");
  });

  it("reads Codex, whose trailer names no model", () => {
    expect(attributeCommit({ message: CODEX_TRAILER })).toEqual({
      agent: "codex",
      model: "",
      source: "trailer",
    });
  });

  it("does NOT count a human co-author trailer as AI", () => {
    // The failure this prevents: pair commits, rebases, and a second
    // machine's git identity all produce Co-authored-by lines. A rule of
    // "has a trailer → AI" would inflate the AI share with the user's own
    // commits. The noreply domain is the discriminator, not the name.
    expect(attributeCommit({ message: HUMAN_TRAILER })).toEqual({
      agent: "human",
      model: "",
      source: "none",
    });
  });

  it("ignores a lookalike name on an unknown domain", () => {
    const spoofed =
      "x\n\nCo-authored-by: Claude Opus 4.7 <someone@example.com>";
    expect(attributeCommit({ message: spoofed }).agent).toBe("human");
  });

  it("takes the first agent trailer when several are present", () => {
    const both = [
      "x",
      "",
      "Co-authored-by: Pranava Raparla <pranava@local>",
      "Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>",
    ].join("\n");
    expect(attributeCommit({ message: both }).agent).toBe("claude");
  });
});

describe("attributeCommit — precedence", () => {
  it("lets a DryDock task's provider beat a conflicting trailer", () => {
    // The task row is ground truth: DryDock dispatched the run and
    // recorded which provider it used.
    const result = attributeCommit({
      message: CLAUDE_TRAILER,
      branch: "drydock/task-123",
      taskProvider: "gemini",
    });
    expect(result.agent).toBe("gemini");
    expect(result.source).toBe("drydock-task");
  });

  it("prefers a trailer over a branch prefix", () => {
    const result = attributeCommit({
      message: CODEX_TRAILER,
      branch: "claude/some-work",
    });
    expect(result.agent).toBe("codex");
    expect(result.source).toBe("trailer");
  });

  it("falls back to the branch prefix when there is no trailer", () => {
    expect(attributeCommit({ message: "x", branch: "jam/foo-123" })).toEqual({
      agent: "jam",
      model: "",
      source: "branch",
    });
  });

  it("strips a remote prefix off the branch", () => {
    expect(attributeCommit({ message: "x", branch: "origin/claude/foo" }).agent)
      .toBe("claude");
    expect(
      attributeCommit({ message: "x", branch: "refs/heads/drydock/t1" }).agent,
    ).toBe("drydock");
  });

  it("treats an unmarked commit as human", () => {
    expect(attributeCommit({ message: "fix: typo", branch: "main" })).toEqual({
      agent: "human",
      model: "",
      source: "none",
    });
  });

  it("survives an empty or missing message", () => {
    expect(attributeCommit({ message: "" }).agent).toBe("human");
    expect(
      attributeCommit({ message: undefined as unknown as string }).agent,
    ).toBe("human");
  });
});

describe("extractModel", () => {
  it("drops the vendor prefix", () => {
    expect(extractModel("Claude Opus 4.7", "claude")).toBe("Opus 4.7");
    expect(extractModel("Claude Fable 5", "claude")).toBe("Fable 5");
  });

  it("returns empty when the trailer named no model", () => {
    expect(extractModel("Claude", "claude")).toBe("");
    expect(extractModel("Codex", "codex")).toBe("");
    expect(extractModel("", "claude")).toBe("");
  });
});

describe("summarizeAttribution", () => {
  const commit = (
    agent: AttributedCommit["agent"],
    source: AttributedCommit["source"],
    model = "",
  ): AttributedCommit => ({
    agent,
    model,
    source,
    additions: 10,
    deletions: 2,
  });

  it("computes per-agent shares over all commits", () => {
    const summary = summarizeAttribution([
      commit("claude", "trailer", "Opus 4.7"),
      commit("claude", "trailer", "Opus 4.7"),
      commit("human", "none"),
      commit("codex", "trailer"),
    ]);
    expect(summary.totalCommits).toBe(4);
    expect(summary.byAgent[0].agent).toBe("claude");
    expect(summary.byAgent[0].share).toBeCloseTo(0.5, 5);
    expect(summary.aiShare).toBeCloseTo(0.75, 5);
  });

  it("reports trailer coverage below 1 when a branch guess was used", () => {
    // The honesty number: a branch prefix says which harness opened the
    // branch, not that a machine wrote the commit. Presenting a
    // branch-inferred share as measured would overstate precision.
    const summary = summarizeAttribution([
      commit("claude", "trailer", "Opus 4.7"),
      commit("jam", "branch"),
    ]);
    expect(summary.trailerCoverage).toBeCloseTo(0.5, 5);
  });

  it("counts a DryDock-dispatched commit as fully attributed", () => {
    const summary = summarizeAttribution([commit("claude", "drydock-task")]);
    expect(summary.trailerCoverage).toBe(1);
  });

  it("reports full coverage when there are no agent commits at all", () => {
    // "We inferred nothing coarsely" is full coverage, not zero.
    const summary = summarizeAttribution([commit("human", "none")]);
    expect(summary.trailerCoverage).toBe(1);
    expect(summary.aiShare).toBe(0);
  });

  it("breaks agent commits down by model, most-used first", () => {
    const summary = summarizeAttribution([
      commit("claude", "trailer", "Opus 4.7"),
      commit("claude", "trailer", "Opus 4.7"),
      commit("claude", "trailer", "Haiku 4.5"),
    ]);
    expect(summary.byModel[0]).toEqual({
      agent: "claude",
      model: "Opus 4.7",
      commits: 2,
    });
  });

  it("is all zeros, not a crash, on no commits", () => {
    const summary = summarizeAttribution([]);
    expect(summary.totalCommits).toBe(0);
    expect(summary.aiShare).toBe(0);
    expect(summary.byAgent).toEqual([]);
  });
});
