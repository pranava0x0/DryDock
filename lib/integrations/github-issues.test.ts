import { describe, expect, it } from "vitest";
import {
  breadcrumb,
  idFromBody,
  isValidRepo,
  issueNumberFromUrl,
  parseRef,
  refFor,
  renderIssueBody,
} from "./github-issues";
import { slugLabel } from "../orchestrator/github-mirror";

describe("issue refs", () => {
  it("round-trips owner/repo#n", () => {
    expect(refFor("pranava0x0/backlog", 42)).toBe("pranava0x0/backlog#42");
    expect(parseRef("pranava0x0/backlog#42")).toEqual({
      repo: "pranava0x0/backlog",
      number: 42,
    });
  });

  it("returns null for anything malformed", () => {
    for (const bad of ["", "no-hash", "owner/repo#", "owner/repo#abc"]) {
      expect(parseRef(bad)).toBeNull();
    }
  });
});

describe("isValidRepo", () => {
  it("accepts owner/name", () => {
    expect(isValidRepo("pranava0x0/backlog")).toBe(true);
    expect(isValidRepo("some-org/my.repo_1")).toBe(true);
  });

  it("rejects anything that isn't", () => {
    // This value is user-entered and goes into an argv array. A typo
    // should be a clear error, not a confusing `gh` failure.
    for (const bad of [
      "",
      "justaname",
      "owner/",
      "/repo",
      "owner/repo/extra",
      "owner repo",
      "owner/repo; rm -rf /",
      42,
      null,
    ]) {
      expect(isValidRepo(bad)).toBe(false);
    }
  });
});

describe("breadcrumb", () => {
  it("survives a round trip through a rendered body", () => {
    // This is what lets a row that lost its stamped ref be re-adopted
    // rather than duplicated into a second issue.
    const body = renderIssueBody({
      id: "abc123XYZ",
      description: "Do the thing",
      projectName: "DryDock",
      source: "manual",
    });
    expect(body).toContain("Do the thing");
    expect(idFromBody(body)).toBe("abc123XYZ");
  });

  it("is an HTML comment, so it doesn't render on GitHub", () => {
    expect(breadcrumb("x1")).toBe("<!-- drydock:id:x1 -->");
  });

  it("returns null when there's no breadcrumb", () => {
    expect(idFromBody("just a normal issue body")).toBeNull();
    expect(idFromBody("")).toBeNull();
  });

  it("handles a body with no description", () => {
    const body = renderIssueBody({
      id: "z9",
      description: null,
      projectName: null,
      source: "github",
    });
    expect(idFromBody(body)).toBe("z9");
    expect(body).toContain("source: github");
  });
});

describe("issueNumberFromUrl", () => {
  it("parses the number out of gh issue create's output", () => {
    // `gh issue create` has no --json, so the URL it prints is the only
    // way back to the number.
    expect(
      issueNumberFromUrl(
        "https://github.com/pranava0x0/backlog/issues/57\n",
      ),
    ).toBe(57);
  });

  it("returns null when the output isn't a URL", () => {
    expect(issueNumberFromUrl("")).toBeNull();
    expect(issueNumberFromUrl("something went wrong")).toBeNull();
  });
});

describe("slugLabel", () => {
  it("makes a label out of a project name", () => {
    expect(slugLabel("Robotics Leadership")).toBe("robotics-leadership");
    expect(slugLabel("FERC Show Cause Orders")).toBe("ferc-show-cause-orders");
  });

  it("trims separators and bounds the length", () => {
    expect(slugLabel("  --Hello--  ")).toBe("hello");
    expect(slugLabel("x".repeat(80)).length).toBeLessThanOrEqual(40);
  });
});
