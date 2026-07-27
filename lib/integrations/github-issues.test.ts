import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetDbForTests, getDb } from "../db/index";
import { setSetting } from "../db/settings";
import {
  breadcrumb,
  idFromBody,
  isValidRepo,
  issueNumberFromUrl,
  parseRef,
  refFor,
  renderIssueBody,
} from "./github-issues";
import {
  addTombstone,
  readTombstones,
  slugLabel,
  TOMBSTONE_KEY,
} from "../orchestrator/github-mirror";

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

describe("deletion tombstones (Codex P2, PR #8)", () => {
  beforeEach(() => {
    _resetDbForTests();
    const dir = mkdtempSync(join(tmpdir(), "drydock-tombstone-"));
    process.env.DRYDOCK_DB_PATH = join(dir, "test.db");
    getDb();
  });

  it("survives the row it refers to", () => {
    // `DELETE /api/backlog/[id]` removes the row AND its
    // `github_issue_ref`, and the mirror only walks live rows — so the
    // orphaned issue could never be found again and would stay open
    // forever in the "durable" tracker.
    addTombstone("owner/backlog#42");
    expect(readTombstones()).toEqual(["owner/backlog#42"]);
  });

  it("does not queue the same ref twice", () => {
    addTombstone("owner/backlog#42");
    addTombstone("owner/backlog#42");
    expect(readTombstones()).toEqual(["owner/backlog#42"]);
  });

  it("ignores an empty ref and survives corrupt storage", () => {
    addTombstone("");
    expect(readTombstones()).toEqual([]);
    setSetting(TOMBSTONE_KEY, "not json");
    expect(readTombstones()).toEqual([]);
    setSetting(TOMBSTONE_KEY, '{"not":"an array"}');
    expect(readTombstones()).toEqual([]);
  });
});

describe("authorship guard (self-review, PR #8)", () => {
  it("recognizes a body DryDock wrote", () => {
    const body = renderIssueBody({
      id: "row-1",
      description: "our description",
      projectName: null,
      source: "manual",
    });
    expect(idFromBody(body)).toBe("row-1");
  });

  it("does not claim a hand-written body", () => {
    // The push gates on this: no breadcrumb means DryDock didn't author
    // the issue, so replacing its body would destroy what the user
    // wrote — in the same sync that imported it.
    const handWritten =
      "## Steps to reproduce\n\n1. Do the thing\n2. Watch it break\n";
    expect(idFromBody(handWritten)).toBeNull();
  });

  it("does not match a DIFFERENT row's breadcrumb", () => {
    const body = renderIssueBody({
      id: "row-1",
      description: null,
      projectName: null,
      source: "manual",
    });
    expect(idFromBody(body)).not.toBe("row-2");
  });
});
