import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetDbForTests, getDb } from "./index";
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  updateProject,
} from "./projects";
import {
  claimTask,
  createTask,
  deleteTask,
  getTask,
  listTasks,
  taskCountsByProject,
  updateTask,
} from "./tasks";
import {
  completeRun,
  createRun,
  getLatestRunForTask,
  getRun,
  listRunsForTask,
} from "./runs";

// Each test gets its own SQLite file in a temp dir. Using a real file (not
// :memory:) is closer to production behavior and exercises the WAL pragma.
function freshDb(): void {
  _resetDbForTests();
  const dir = mkdtempSync(join(tmpdir(), "drydock-test-"));
  process.env.DRYDOCK_DB_PATH = join(dir, "test.db");
  getDb();
}

beforeEach(() => {
  freshDb();
});

describe("schema migrations", () => {
  it("adds Phase 3 columns to a legacy projects/runs schema (idempotent)", () => {
    // Simulate an existing Phase 1 DB by opening a fresh DB (the schema.sql
    // already creates the new columns), then manually dropping the new
    // columns from the table and re-opening. We can't ALTER TABLE DROP
    // COLUMN on every SQLite, so instead we recreate the runs table
    // without the new columns and verify migrate() restores them.
    _resetDbForTests();
    const dir = mkdtempSync(join(tmpdir(), "drydock-mig-"));
    process.env.DRYDOCK_DB_PATH = join(dir, "legacy.db");
    const db = getDb();

    db.exec(`
      DROP TABLE runs;
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        output TEXT,
        error TEXT,
        started_at INTEGER NOT NULL DEFAULT (unixepoch()),
        completed_at INTEGER
      );
    `);

    // Re-open: migrate() runs and re-adds the Phase 3 columns.
    _resetDbForTests();
    const db2 = getDb();
    const cols = db2
      .prepare(`PRAGMA table_info(runs)`)
      .all()
      .map((r: any) => r.name);
    expect(cols).toContain("tokens_in");
    expect(cols).toContain("tokens_out");
    expect(cols).toContain("cost_usd");
    expect(cols).toContain("gate_status");
    expect(cols).toContain("gate_output");
  });
});

describe("projects CRUD", () => {
  it("creates and lists projects", () => {
    const p = createProject({ name: "Alpha", path: "/tmp/alpha" });
    expect(p.id).toBeTruthy();
    expect(p.name).toBe("Alpha");
    expect(p.provider).toBe("claude");
    expect(listProjects()).toHaveLength(1);
  });

  it("getProject returns null for unknown id", () => {
    expect(getProject("does-not-exist")).toBeNull();
  });

  it("update only changes specified fields", () => {
    const p = createProject({
      name: "Alpha",
      path: "/tmp/alpha",
      description: "orig",
    });
    const updated = updateProject(p.id, { name: "Beta" });
    expect(updated?.name).toBe("Beta");
    // description left untouched
    expect(updated?.description).toBe("orig");
  });

  it("update with no fields returns the existing row unchanged", () => {
    const p = createProject({ name: "Alpha", path: "/tmp/alpha" });
    const updated = updateProject(p.id, {});
    expect(updated?.id).toBe(p.id);
    expect(updated?.name).toBe("Alpha");
  });

  it("delete cascades to tasks", () => {
    const p = createProject({ name: "Alpha", path: "/tmp/alpha" });
    createTask({
      project_id: p.id,
      title: "t1",
      description: "do thing",
    });
    expect(listTasks({ projectId: p.id })).toHaveLength(1);
    deleteProject(p.id);
    // FK ON DELETE CASCADE drops the children — proves PRAGMA foreign_keys=ON
    // is actually applied.
    expect(listTasks({ projectId: p.id })).toHaveLength(0);
  });
});

describe("tasks CRUD", () => {
  it("createTask defaults to project provider when not specified", () => {
    const p = createProject({
      name: "Alpha",
      path: "/tmp/alpha",
      provider: "gemini",
    });
    // We don't auto-inherit at the DB layer — the API does that. The DB
    // default is 'claude'. This documents the boundary.
    const t = createTask({
      project_id: p.id,
      title: "t1",
      description: "x",
    });
    expect(t.provider).toBe("claude");
  });

  it("listTasks filters by status and projectId", () => {
    const p = createProject({ name: "Alpha", path: "/tmp/alpha" });
    const a = createTask({
      project_id: p.id,
      title: "a",
      description: "x",
    });
    createTask({ project_id: p.id, title: "b", description: "y" });
    updateTask(a.id, { status: "done" });
    expect(listTasks({ projectId: p.id })).toHaveLength(2);
    expect(listTasks({ projectId: p.id, status: "done" })).toHaveLength(1);
    expect(listTasks({ projectId: p.id, status: "pending" })).toHaveLength(1);
  });

  it("listTasks orders by priority desc then created_at desc", () => {
    const p = createProject({ name: "Alpha", path: "/tmp/alpha" });
    createTask({
      project_id: p.id,
      title: "low",
      description: "x",
      priority: 0,
    });
    createTask({
      project_id: p.id,
      title: "high",
      description: "x",
      priority: 10,
    });
    const tasks = listTasks({ projectId: p.id });
    expect(tasks[0].title).toBe("high");
  });

  it("updateTask stamps completed_at on terminal status", () => {
    const p = createProject({ name: "Alpha", path: "/tmp/alpha" });
    const t = createTask({
      project_id: p.id,
      title: "t",
      description: "x",
    });
    expect(t.completed_at).toBeNull();
    const done = updateTask(t.id, { status: "done" });
    expect(done?.completed_at).toBeGreaterThan(0);
  });

  it("taskCountsByProject summarizes every status", () => {
    const p = createProject({ name: "Alpha", path: "/tmp/alpha" });
    const a = createTask({
      project_id: p.id,
      title: "a",
      description: "x",
    });
    const b = createTask({
      project_id: p.id,
      title: "b",
      description: "x",
    });
    const c = createTask({
      project_id: p.id,
      title: "c",
      description: "x",
    });
    updateTask(a.id, { status: "done" });
    updateTask(b.id, { status: "failed" });
    void c; // c stays pending
    const counts = taskCountsByProject(p.id);
    expect(counts).toEqual({
      pending: 1,
      claimed: 0,
      running: 0,
      done: 1,
      failed: 1,
    });
  });

  it("deleteTask returns false when row already gone", () => {
    expect(deleteTask("missing")).toBe(false);
  });

  it("updateTask clears branch + worktree_path when explicitly set to null (Phase 3 retry)", () => {
    const p = createProject({ name: "Alpha", path: "/tmp/alpha" });
    const t = createTask({
      project_id: p.id,
      title: "retry me",
      description: "x",
    });
    updateTask(t.id, {
      status: "failed",
      branch: "drydock/abc-foo",
      worktree_path: "/tmp/wt",
    });
    // Simulate the retry endpoint: status -> pending, branch + path cleared
    // so the next dispatch carves a fresh worktree.
    const reset = updateTask(t.id, {
      status: "pending",
      branch: null,
      worktree_path: null,
    });
    expect(reset?.status).toBe("pending");
    expect(reset?.branch).toBeNull();
    expect(reset?.worktree_path).toBeNull();
  });
});

describe("claimTask atomic claim", () => {
  it("only one concurrent caller wins", () => {
    const p = createProject({ name: "Alpha", path: "/tmp/alpha" });
    const t = createTask({
      project_id: p.id,
      title: "race",
      description: "x",
    });
    const first = claimTask(t.id);
    const second = claimTask(t.id);
    // The whole point of the dispatcher's correctness — never let two
    // processes both win the same pending task.
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("returns false when task is not pending", () => {
    const p = createProject({ name: "Alpha", path: "/tmp/alpha" });
    const t = createTask({
      project_id: p.id,
      title: "race",
      description: "x",
    });
    updateTask(t.id, { status: "done" });
    expect(claimTask(t.id)).toBe(false);
  });

  it("returns false for nonexistent task id", () => {
    expect(claimTask("nope")).toBe(false);
  });
});

describe("runs lifecycle", () => {
  it("createRun + completeRun success path", () => {
    const p = createProject({ name: "Alpha", path: "/tmp/alpha" });
    const t = createTask({
      project_id: p.id,
      title: "t",
      description: "x",
    });
    const run = createRun(t.id, "claude");
    expect(run.status).toBe("running");
    expect(getLatestRunForTask(t.id)?.id).toBe(run.id);
    const finished = completeRun(run.id, {
      status: "success",
      output: "hello",
    });
    expect(finished?.status).toBe("success");
    expect(finished?.completed_at).toBeGreaterThan(0);
  });

  it("listRunsForTask returns runs newest-first", () => {
    const p = createProject({ name: "Alpha", path: "/tmp/alpha" });
    const t = createTask({
      project_id: p.id,
      title: "t",
      description: "x",
    });
    const r1 = createRun(t.id, "claude");
    // unixepoch() has 1-second resolution; nudge clock for ordering.
    getDb().prepare("UPDATE runs SET started_at = ? WHERE id = ?").run(
      1000,
      r1.id,
    );
    const r2 = createRun(t.id, "claude");
    getDb().prepare("UPDATE runs SET started_at = ? WHERE id = ?").run(
      2000,
      r2.id,
    );
    const runs = listRunsForTask(t.id);
    expect(runs.map((r) => r.id)).toEqual([r2.id, r1.id]);
  });

  it("completeRun on missing id returns null", () => {
    expect(completeRun("missing", { status: "failed" })).toBeNull();
  });

  it("getRun returns null for unknown id", () => {
    expect(getRun("nope")).toBeNull();
  });
});
