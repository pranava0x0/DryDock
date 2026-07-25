import { describe, expect, it } from "vitest";
import {
  isEncodingAmbiguous,
  projectKeyFromCwd,
  projectKeyFromEncodedDir,
} from "./claude-projects";

describe("projectKeyFromCwd", () => {
  it("uses the directory basename", () => {
    expect(projectKeyFromCwd("/Users/pranava/Projects/DryDock")).toEqual({
      key: "DryDock",
      ambiguous: false,
    });
  });

  it("collapses a worktree onto its parent project", () => {
    // Every DryDock-dispatched task runs in such a worktree. Without this
    // collapse each task would register as its own project.
    expect(
      projectKeyFromCwd(
        "/Users/pranava/Projects/DryDock/.claude/worktrees/ep10-usage-a1b2c3",
      ),
    ).toEqual({ key: "DryDock", ambiguous: false });
  });

  it("keeps spaces in project names intact (the dash-collision case)", () => {
    // The encoded directory for this cwd is
    // `-Users-pranava-Projects-Robotics-Leadership--claude-worktrees-…`,
    // which naively decodes to a project called "Robotics". Reading the
    // cwd instead gets it right.
    expect(
      projectKeyFromCwd(
        "/Users/pranava/Projects/Robotics Leadership/.claude/worktrees/robotics-policy-site-review-51b91b",
      ),
    ).toEqual({ key: "Robotics Leadership", ambiguous: false });
  });

  it("keeps a literal dash in a project name intact", () => {
    expect(projectKeyFromCwd("/Users/pranava/Projects/ppa-helper")).toEqual({
      key: "ppa-helper",
      ambiguous: false,
    });
  });

  it("tolerates trailing slashes", () => {
    expect(projectKeyFromCwd("/Users/pranava/Projects/DryDock/").key).toBe(
      "DryDock",
    );
  });

  it("returns unknown (not a guess) for empty or root-ish input", () => {
    for (const bad of ["", "   ", "/"]) {
      expect(projectKeyFromCwd(bad)).toEqual({ key: "", ambiguous: true });
    }
  });
});

describe("projectKeyFromEncodedDir", () => {
  it("flags every derived key as ambiguous", () => {
    // The whole point: a key from the encoded dir name is a hint, never a
    // fact, because `-` stands for `/`, `.`, and ` ` alike.
    const result = projectKeyFromEncodedDir(
      "-Users-pranava-Projects-Robotics-Leadership--claude-worktrees-x",
    );
    expect(result.ambiguous).toBe(true);
  });

  it("does not attempt to reconstruct a path", () => {
    // A regression pin: if someone reintroduces `.replaceAll("-", "/")`
    // this fails, because that is exactly how you invent a project named
    // "Robotics" that has never existed.
    const result = projectKeyFromEncodedDir("-Users-pranava-Projects-DryDock");
    expect(result.key).not.toContain("/");
  });

  it("returns unknown for a dashes-only or empty name", () => {
    expect(projectKeyFromEncodedDir("---")).toEqual({
      key: "",
      ambiguous: true,
    });
    expect(projectKeyFromEncodedDir("")).toEqual({ key: "", ambiguous: true });
  });
});

describe("isEncodingAmbiguous", () => {
  it("is true whenever a dash survives past the leading separator", () => {
    expect(isEncodingAmbiguous("-Users-pranava-Projects-DryDock")).toBe(true);
  });

  it("is false for a single top-level segment", () => {
    expect(isEncodingAmbiguous("-tmp")).toBe(false);
  });
});
