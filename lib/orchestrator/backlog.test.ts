import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetDbForTests, getDb } from "../db";
import { createProject } from "../db/projects";
import {
  createBacklogItem,
  getBacklogItem,
  listBacklog,
  updateBacklogItem,
} from "../db/backlog";
import { getTask } from "../db/tasks";
import { getSetting, setSetting } from "../db/settings";
import { DEFAULT_NOTE_TITLE } from "../integrations/apple-notes";
import {
  backlogSummary,
  BurnDownError,
  burnDownBacklogItem,
  dedupeBacklogItems,
  getLastSyncedAt,
  getNotesTitle,
  NOTES_LAST_SYNC_KEY,
  NOTES_TITLE_KEY,
} from "./backlog";

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

describe("dedupeBacklogItems", () => {
  it("collapses same-title rows across manual + apple-notes sources", () => {
    const manual = createBacklogItem({ title: "Add dark mode" });
    const fromNote = createBacklogItem({
      title: "Add dark mode",
      source: "apple-notes",
      external_id: "darkmode",
    });

    const report = dedupeBacklogItems();
    expect(report.removed).toBe(1);
    expect(report.groupsMerged).toBe(1);

    // Apple-notes-sourced row wins the keeper slot — it has a stable
    // external_id that survives a future re-sync without minting a
    // new row.
    expect(getBacklogItem(fromNote.id)).not.toBeNull();
    expect(getBacklogItem(manual.id)).toBeNull();
  });

  it("treats trimmed and case-folded titles as the same group", () => {
    const a = createBacklogItem({ title: "Refactor auth" });
    const b = createBacklogItem({ title: "  refactor AUTH  " });

    const report = dedupeBacklogItems();
    expect(report.removed).toBe(1);
    // Same source: keeper is the older row (a was inserted first).
    expect(getBacklogItem(a.id)).not.toBeNull();
    expect(getBacklogItem(b.id)).toBeNull();
  });

  it("merges status onto the keeper using done > in_progress > idea > dropped", () => {
    const proj = createProject({ name: "P", path: "/tmp/p" });
    const keeper = createBacklogItem({
      title: "Ship feature",
      source: "apple-notes",
      external_id: "ship",
    });
    // Newer manual copy has status=done — the merge must promote the
    // keeper to done so the user doesn't see a resurrected idea.
    const completed = createBacklogItem({
      title: "Ship feature",
      project_id: proj.id,
      status: "in_progress",
    });
    updateBacklogItem(completed.id, { status: "done" });

    dedupeBacklogItems();

    const merged = getBacklogItem(keeper.id);
    expect(merged?.status).toBe("done");
    // project_id was null on the keeper and set on the duplicate — the
    // merge fills it in rather than clobbering with null.
    expect(merged?.project_id).toBe(proj.id);
  });

  it("does not clobber a project_id on the keeper with null from a duplicate", () => {
    const proj = createProject({ name: "P", path: "/tmp/p" });
    const keeper = createBacklogItem({
      title: "Has project",
      source: "apple-notes",
      external_id: "k",
      project_id: proj.id,
    });
    createBacklogItem({ title: "Has project" }); // project_id: null

    dedupeBacklogItems();

    expect(getBacklogItem(keeper.id)?.project_id).toBe(proj.id);
  });

  it("leaves singletons alone and reports zero work", () => {
    createBacklogItem({ title: "alone" });
    createBacklogItem({ title: "also alone" });

    const report = dedupeBacklogItems();
    expect(report.removed).toBe(0);
    expect(report.groupsMerged).toBe(0);
    expect(listBacklog()).toHaveLength(2);
  });

  it("handles 3+ duplicates in a single group", () => {
    createBacklogItem({ title: "thrice" });
    createBacklogItem({ title: "thrice" });
    createBacklogItem({ title: "thrice" });

    const report = dedupeBacklogItems();
    expect(report.removed).toBe(2);
    expect(report.groupsMerged).toBe(1);
    expect(
      listBacklog().filter((i) => i.title.trim().toLowerCase() === "thrice"),
    ).toHaveLength(1);
  });
});

describe("getNotesTitle migration", () => {
  it("returns the new emoji-prefixed default when nothing is stored", () => {
    expect(getNotesTitle()).toBe(DEFAULT_NOTE_TITLE);
    expect(DEFAULT_NOTE_TITLE).toContain("⚓");
  });

  it("upgrades the legacy 'DryDock Backlog' (no anchor) to the new default in place", () => {
    // Older installs persisted the no-anchor string. Apple Notes
    // derives the note's name from the body's first line (which
    // includes the anchor), so the legacy stored value caused the
    // by-name fallback to match zero candidates and silently create a
    // new note on every sync. getNotesTitle migrates the stored value
    // when it reads it.
    setSetting(NOTES_TITLE_KEY, "DryDock Backlog");
    expect(getNotesTitle()).toBe(DEFAULT_NOTE_TITLE);
    // Persisted, not just transformed on read — second call sees the
    // upgraded value directly.
    expect(getSetting(NOTES_TITLE_KEY)).toBe(DEFAULT_NOTE_TITLE);
  });

  it("leaves a user-customized title alone", () => {
    setSetting(NOTES_TITLE_KEY, "My Personal Backlog");
    expect(getNotesTitle()).toBe("My Personal Backlog");
    expect(getSetting(NOTES_TITLE_KEY)).toBe("My Personal Backlog");
  });
});

describe("getLastSyncedAt", () => {
  it("returns null before the first sync has been recorded", () => {
    expect(getLastSyncedAt()).toBeNull();
  });

  it("reads back the Unix-seconds timestamp persisted on a successful sync", () => {
    // The orchestrator records this on a successful runSyncOnce; we
    // simulate it here to verify the getter doesn't lose precision or
    // misinterpret the string-encoded number.
    const ts = 1747500000;
    setSetting(NOTES_LAST_SYNC_KEY, String(ts));
    expect(getLastSyncedAt()).toBe(ts);
  });

  it("returns null for a non-numeric value (corrupt setting)", () => {
    setSetting(NOTES_LAST_SYNC_KEY, "garbage");
    expect(getLastSyncedAt()).toBeNull();
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
