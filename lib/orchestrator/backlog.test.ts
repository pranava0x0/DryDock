import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetDbForTests, getDb } from "../db";
import { createProject } from "../db/projects";
import { createBacklogItem, getBacklogItem } from "../db/backlog";
import { getTask } from "../db/tasks";
import { backlogSummary, BurnDownError, burnDownBacklogItem } from "./backlog";

beforeEach(() => {
  _resetDbForTests();
  const dir = mkdtempSync(join(tmpdir(), "drydock-burn-"));
  process.env.DRYDOCK_DB_PATH = join(dir, "burn.db");
  getDb();
});

describe("burnDownBacklogItem", () => {
  it("creates a task in the linked project and flips the item to in_progress", () => {
    const project = createProject({ name: "P", path: "/tmp/p" });
    const item = createBacklogItem({
      title: "Add dark mode",
      description: "details here",
      project_id: project.id,
    });
    const result = burnDownBacklogItem(item.id);
    const task = getTask(result.taskId);
    expect(task?.title).toBe("Add dark mode");
    expect(task?.project_id).toBe(project.id);
    expect(task?.status).toBe("pending");

    const fresh = getBacklogItem(item.id);
    expect(fresh?.status).toBe("in_progress");
    expect(fresh?.task_id).toBe(result.taskId);
  });

  it("respects an override project_id when the item is unassigned", () => {
    const project = createProject({ name: "P", path: "/tmp/p" });
    const item = createBacklogItem({ title: "unassigned idea" });
    const result = burnDownBacklogItem(item.id, project.id);
    const task = getTask(result.taskId);
    expect(task?.project_id).toBe(project.id);
    const fresh = getBacklogItem(item.id);
    expect(fresh?.project_id).toBe(project.id);
  });

  it("throws project_required when no project is set or passed", () => {
    const item = createBacklogItem({ title: "general idea" });
    try {
      burnDownBacklogItem(item.id);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BurnDownError);
      expect((err as BurnDownError).code).toBe("project_required");
    }
  });

  it("throws item_not_found for unknown ids", () => {
    try {
      burnDownBacklogItem("missing");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BurnDownError);
      expect((err as BurnDownError).code).toBe("item_not_found");
    }
  });
});

describe("backlogSummary", () => {
  it("counts per status and per project", () => {
    const a = createProject({ name: "A", path: "/tmp/a" });
    const b = createProject({ name: "B", path: "/tmp/b" });
    createBacklogItem({ title: "1", project_id: a.id });
    createBacklogItem({ title: "2", project_id: a.id, status: "in_progress" });
    createBacklogItem({ title: "3", project_id: b.id, status: "done" });
    createBacklogItem({ title: "4" }); // unassigned

    const s = backlogSummary();
    expect(s.total).toBe(4);
    // Items 1 and 4 default to "idea" status; 2 is in_progress; 3 is done.
    expect(s.idea).toBe(2);
    expect(s.in_progress).toBe(1);
    expect(s.done).toBe(1);
    // 3 buckets: A, B, unassigned (null)
    expect(s.byProject).toHaveLength(3);
    const aBucket = s.byProject.find((p) => p.projectId === a.id);
    expect(aBucket?.count).toBe(2);
    expect(aBucket?.projectName).toBe("A");
    const unassigned = s.byProject.find((p) => p.projectId === null);
    expect(unassigned?.count).toBe(1);
  });
});
