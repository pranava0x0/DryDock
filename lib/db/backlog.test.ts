import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetDbForTests, getDb } from "./index";
import { createProject } from "./projects";
import {
  createBacklogItem,
  deleteBacklogItem,
  getBacklogItem,
  getBacklogItemByExternalId,
  listBacklog,
  updateBacklogItem,
} from "./backlog";

beforeEach(() => {
  _resetDbForTests();
  const dir = mkdtempSync(join(tmpdir(), "drydock-backlog-"));
  process.env.DRYDOCK_DB_PATH = join(dir, "backlog.db");
  getDb();
});

describe("backlog CRUD", () => {
  it("create defaults source=manual, status=idea", () => {
    const item = createBacklogItem({ title: "Cross-project idea" });
    expect(item.status).toBe("idea");
    expect(item.source).toBe("manual");
    expect(item.project_id).toBeNull();
    expect(item.task_id).toBeNull();
  });

  it("listBacklog orders by priority desc then created_at desc", () => {
    createBacklogItem({ title: "low" });
    createBacklogItem({ title: "high", priority: 10 });
    createBacklogItem({ title: "mid", priority: 5 });
    const list = listBacklog();
    expect(list.map((i) => i.title)).toEqual(["high", "mid", "low"]);
  });

  it("listBacklog filters by status + unassigned", () => {
    const p = createProject({ name: "P", path: "/tmp/p" });
    createBacklogItem({ title: "a" });
    createBacklogItem({ title: "b", project_id: p.id });
    expect(listBacklog({ projectId: "unassigned" }).map((i) => i.title)).toEqual(["a"]);
    expect(listBacklog({ projectId: p.id }).map((i) => i.title)).toEqual(["b"]);
  });

  it("updateBacklogItem stamps completed_at when status reaches done/dropped", () => {
    const item = createBacklogItem({ title: "x" });
    expect(item.completed_at).toBeNull();
    const done = updateBacklogItem(item.id, { status: "done" });
    expect(done?.completed_at).toBeGreaterThan(0);
    const item2 = createBacklogItem({ title: "y" });
    const dropped = updateBacklogItem(item2.id, { status: "dropped" });
    expect(dropped?.completed_at).toBeGreaterThan(0);
  });

  it("deleteBacklogItem returns false when row already gone", () => {
    expect(deleteBacklogItem("missing")).toBe(false);
  });

  it("getBacklogItemByExternalId returns the right row", () => {
    createBacklogItem({
      title: "from notes",
      source: "apple-notes",
      external_id: "abc123",
    });
    expect(getBacklogItemByExternalId("abc123")?.title).toBe("from notes");
    expect(getBacklogItemByExternalId("nope")).toBeNull();
  });

  it("honors an explicit created_at when rebuilding history from Apple Notes", () => {
    // The Apple Notes pull passes through a parsed `· added YYYY-MM-DD`
    // timestamp so a wipe-and-resync preserves the user's history
    // instead of stamping everything with today's date.
    const ts = Math.floor(Date.UTC(2026, 0, 15) / 1000);
    const item = createBacklogItem({
      title: "historical",
      source: "apple-notes",
      external_id: "hist",
      created_at: ts,
    });
    expect(item.created_at).toBe(ts);
    // updated_at gets the same value so the row reads as historical
    // rather than "modified today" — important for the dashboard's
    // sort-by-recency.
    expect(item.updated_at).toBe(ts);
  });

  it("ignores a non-finite created_at and falls back to unixepoch()", () => {
    const before = Math.floor(Date.now() / 1000);
    // Number.NaN typechecks as `number` so callers can leak garbage
    // through optional-pass-through patterns — the helper must guard
    // for that rather than store NaN.
    const item = createBacklogItem({
      title: "nan",
      created_at: Number.NaN,
    });
    expect(item.created_at).toBeGreaterThanOrEqual(before);
  });

  it("project SET NULL on delete keeps the backlog item", () => {
    const p = createProject({ name: "P", path: "/tmp/p" });
    const item = createBacklogItem({ title: "x", project_id: p.id });
    getDb().prepare("DELETE FROM projects WHERE id = ?").run(p.id);
    const fresh = getBacklogItem(item.id);
    expect(fresh).not.toBeNull();
    expect(fresh?.project_id).toBeNull();
  });
});
