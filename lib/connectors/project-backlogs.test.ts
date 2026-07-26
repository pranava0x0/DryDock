import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetDbForTests, getDb } from "../db/index";
import { listBacklog } from "../db/backlog";
import { createProject } from "../db/projects";
import {
  importProjectBacklogs,
  parseBacklogMarkdown,
  scanProjectBacklog,
} from "./project-backlogs";

let root: string;

beforeEach(() => {
  _resetDbForTests();
  root = mkdtempSync(join(tmpdir(), "drydock-projbacklog-"));
  process.env.DRYDOCK_DB_PATH = join(root, "test.db");
  getDb();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeProject(name: string, files: Record<string, string>) {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(join(path, file), content);
  }
  return createProject({ name, path, provider: "claude" });
}

describe("parseBacklogMarkdown", () => {
  it("reads task list items and plain bullets", () => {
    const items = parseBacklogMarkdown(
      ["- [ ] add rate limiting", "* plain bullet idea", "+ another one"].join(
        "\n",
      ),
    );
    expect(items.map((i) => i.title)).toEqual([
      "add rate limiting",
      "plain bullet idea",
      "another one",
    ]);
    expect(items.every((i) => !i.done)).toBe(true);
  });

  it("marks checked and struck-through items done", () => {
    const items = parseBacklogMarkdown(
      ["- [x] shipped thing", "- ~~abandoned thing~~"].join("\n"),
    );
    expect(items.every((i) => i.done)).toBe(true);
  });

  it("ignores bullets inside fenced code blocks", () => {
    // A `- item` in a shell example is not a backlog item, and importing
    // one would be noise with no obvious origin.
    const items = parseBacklogMarkdown(
      [
        "- real idea",
        "```bash",
        "- not an idea",
        "npm install -- --flag",
        "```",
        "- another real idea",
      ].join("\n"),
    );
    expect(items.map((i) => i.title)).toEqual([
      "real idea",
      "another real idea",
    ]);
  });

  it("attaches the section heading an item sits under", () => {
    const items = parseBacklogMarkdown(
      ["## Active", "- do this", "## Shipped", "- [x] did that"].join("\n"),
    );
    expect(items[0].section).toBe("Active");
    expect(items[1].section).toBe("Shipped");
  });

  it("strips markdown formatting out of titles", () => {
    const items = parseBacklogMarkdown(
      "- **Bold** idea with [a link](http://x) and `code`",
    );
    expect(items[0].title).toBe("Bold idea with a link and code");
  });

  it("reads DD-BL-style table rows, skipping header and separator", () => {
    const items = parseBacklogMarkdown(
      [
        "| ID | Feature | Priority | Status |",
        "|---|---|---|---|",
        "| DD-BL-12 | Cost rollup on the dashboard | P3 | Not Started |",
        "| DD-BL-11 | Something shipped | P2 | Shipped |",
      ].join("\n"),
    );
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe("Cost rollup on the dashboard");
    expect(items[0].done).toBe(false);
    // A shipped row is read as done rather than skipped, so a re-import
    // can't resurrect it as a fresh idea.
    expect(items[1].done).toBe(true);
  });

  it("ignores prose, headings, and empty lines", () => {
    const items = parseBacklogMarkdown(
      ["# Backlog", "", "Some intro prose.", "", "- the only item"].join("\n"),
    );
    expect(items).toHaveLength(1);
  });
});

describe("scanProjectBacklog", () => {
  it("finds the first matching filename and skips done items", () => {
    const project = makeProject("Alpha", {
      "backlog.md": ["- [ ] open one", "- [x] closed one"].join("\n"),
    });
    return scanProjectBacklog(project).then((scan) => {
      expect(scan.file).toBe("backlog.md");
      expect(scan.items.map((i) => i.title)).toEqual(["open one"]);
    });
  });

  it("says so when a project has no backlog file", async () => {
    const project = makeProject("Bravo", { "README.md": "# hi" });
    const scan = await scanProjectBacklog(project);
    expect(scan.file).toBeNull();
    expect(scan.reason).toContain("no backlog file");
    expect(scan.items).toEqual([]);
  });

  it("caps items per project and reports what it left behind", async () => {
    // One huge file must not flood the inbox — but silently truncating
    // would read as "that's everything", so the count is reported.
    const many = Array.from({ length: 60 }, (_, i) => `- idea ${i}`).join("\n");
    const project = makeProject("Charlie", { "backlog.md": many });
    const scan = await scanProjectBacklog(project);
    expect(scan.items).toHaveLength(40);
    expect(scan.skipped).toBe(20);
  });
});

describe("importProjectBacklogs", () => {
  it("files each project's items into the inbox, tagged to that project", async () => {
    const project = makeProject("Delta", {
      "backlog.md": ["## Ideas", "- ship the thing", "- fix the other thing"].join(
        "\n",
      ),
    });

    const [result] = await importProjectBacklogs();
    expect(result.created).toBe(2);

    const inbox = listBacklog({ stage: "inbox" });
    expect(inbox).toHaveLength(2);
    expect(inbox.every((i) => i.project_id === project.id)).toBe(true);
    expect(inbox.every((i) => i.source === "project-file")).toBe(true);
    expect(inbox[0].description).toContain("Delta/backlog.md");
  });

  it("is idempotent — re-importing does not duplicate", async () => {
    makeProject("Echo", { "backlog.md": "- one idea" });
    await importProjectBacklogs();
    const second = await importProjectBacklogs();
    expect(second[0].created).toBe(0);
    expect(listBacklog()).toHaveLength(1);
  });

  it("reports a project with no backlog file without failing the run", async () => {
    makeProject("Foxtrot", { "backlog.md": "- has one" });
    makeProject("Golf", { "README.md": "# none here" });

    const results = await importProjectBacklogs();
    expect(results).toHaveLength(2);
    const golf = results.find((r) => r.projectName === "Golf")!;
    expect(golf.reason).toContain("no backlog file");
    expect(results.find((r) => r.projectName === "Foxtrot")!.created).toBe(1);
  });

  it("never writes back to the project's file", async () => {
    const content = "- one idea\n";
    const project = makeProject("Hotel", { "backlog.md": content });
    await importProjectBacklogs();
    const after = await scanProjectBacklog(project);
    expect(after.items.map((i) => i.title)).toEqual(["one idea"]);
  });
});

describe("reconciliation (Codex P2, PR #8)", () => {
  it("closes a row when its source line is later ticked", async () => {
    // Previously the `done` filter dropped completed lines entirely, so
    // the import loop never saw them again and an already-imported row
    // stayed actionable in DryDock forever.
    const path = join(root, "India");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "backlog.md"), "- [ ] ship the thing\n");
    createProject({ name: "India", path, provider: "claude" });

    await importProjectBacklogs();
    expect(listBacklog({ stage: "inbox" })[0].status).toBe("idea");

    writeFileSync(join(path, "backlog.md"), "- [x] ship the thing\n");
    const [result] = await importProjectBacklogs();

    expect(result.completed).toBe(1);
    expect(listBacklog()[0].status).toBe("done");
  });

  it("never creates a row for a line that was already done", async () => {
    makeProject("Juliet", { "backlog.md": "- [x] historical thing\n" });
    const [result] = await importProjectBacklogs();
    expect(result.created).toBe(0);
    expect(result.completed).toBe(0);
    expect(listBacklog()).toHaveLength(0);
  });

  it("REFRESHES a renamed line instead of duplicating it", async () => {
    // Identity is (project, file, ordinal), not the title slug — a slug
    // changes the moment the line is reworded, and the old identity
    // scheme then created a second row and left the stale title behind.
    const path = join(root, "Kilo");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "backlog.md"), "- add rate limiting\n");
    createProject({ name: "Kilo", path, provider: "claude" });

    await importProjectBacklogs();
    writeFileSync(
      join(path, "backlog.md"),
      "- add rate limiting to the tunnel endpoints\n",
    );
    const [result] = await importProjectBacklogs();

    expect(result.updated).toBe(1);
    expect(result.created).toBe(0);
    const rows = listBacklog();
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("add rate limiting to the tunnel endpoints");
  });

  it("gives each line its own identity so two items never collide", async () => {
    makeProject("Lima", {
      "backlog.md": ["- first idea", "- second idea"].join("\n"),
    });
    await importProjectBacklogs();
    expect(listBacklog()).toHaveLength(2);
  });
});
