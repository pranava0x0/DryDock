import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetDbForTests, getDb } from "../db/index";
import {
  createBacklogItem,
  getBacklogItem,
  inboxCount,
  listBacklog,
  triageBacklogItem,
} from "../db/backlog";
import { createProject } from "../db/projects";
import { intakeCapture } from "./intake";

beforeEach(() => {
  _resetDbForTests();
  const dir = mkdtempSync(join(tmpdir(), "drydock-intake-test-"));
  process.env.DRYDOCK_DB_PATH = join(dir, "test.db");
  getDb();
});

describe("intakeCapture", () => {
  it("lands a capture in the inbox, not the backlog", () => {
    const result = intakeCapture({
      text: "rate limiter for the tunnel endpoints",
      source: "shortcut",
    });
    expect(result.outcome).toBe("created");
    expect(result.item!.triaged_at).toBeNull();
    expect(listBacklog({ stage: "triaged" })).toHaveLength(0);
    expect(listBacklog({ stage: "inbox" })).toHaveLength(1);
    expect(inboxCount()).toBe(1);
  });

  it("preserves the raw capture verbatim alongside the parsed title", () => {
    const result = intakeCapture({
      text: "rate limiter for the tunnel p2 #nope",
      source: "shortcut",
    });
    expect(result.item!.title).toBe("rate limiter for the tunnel");
    expect(result.item!.raw_capture).toBe(
      "rate limiter for the tunnel p2 #nope",
    );
    expect(result.item!.priority).toBe(2);
  });

  it("resolves a #marker to a real project", () => {
    const project = createProject({
      name: "DryDock",
      path: "/tmp/drydock",
      provider: "claude",
    });
    const result = intakeCapture({
      text: "tunnel rate limiter #drydock",
      source: "shortcut",
    });
    expect(result.item!.project_id).toBe(project.id);
  });

  it("is idempotent on a repeated idempotency key", () => {
    // A Shortcut over a flaky tunnel will fire twice. Without this
    // that's two identical rows to sweep every morning.
    const first = intakeCapture({
      text: "tunnel rate limiter",
      source: "shortcut",
      externalId: "capture:abc123",
    });
    const second = intakeCapture({
      text: "tunnel rate limiter",
      source: "shortcut",
      externalId: "capture:abc123",
    });
    expect(first.outcome).toBe("created");
    expect(second.outcome).toBe("duplicate");
    expect(second.item!.id).toBe(first.item!.id);
    expect(listBacklog({ stage: "inbox" })).toHaveLength(1);
  });

  it("refreshes in place when the same external id brings new text", () => {
    // How an edited backlog.md line or a re-generated idea spec updates
    // without duplicating.
    intakeCapture({
      text: "old title",
      source: "project-file",
      externalId: "projfile:p1:oldtitle",
    });
    const updated = intakeCapture({
      text: "new title",
      source: "project-file",
      externalId: "projfile:p1:oldtitle",
    });
    expect(updated.outcome).toBe("updated");
    expect(listBacklog({ stage: "inbox" })).toHaveLength(1);
    expect(updated.item!.title).toBe("new title");
  });

  it("treats an exact title match as a duplicate without writing", () => {
    createBacklogItem({ title: "Refresh the permit tracker" });
    const result = intakeCapture({
      text: "refresh the permit tracker",
      source: "shortcut",
    });
    expect(result.outcome).toBe("duplicate");
    expect(listBacklog()).toHaveLength(1);
  });

  it("INSERTS a near-match with a note instead of dropping it", () => {
    // The rule the whole intake path rests on. Silently discarding a
    // real idea because it scored 0.61 against something else is the
    // silent failure the house rules ban — an unwanted row costs one tap.
    createBacklogItem({
      title: "Add a rate limiter to the tunnel endpoints",
    });
    const result = intakeCapture({
      text: "Add rate limiter to tunnel endpoints",
      source: "shortcut",
    });
    expect(result.outcome).toBe("created");
    expect(result.similar.length).toBeGreaterThan(0);
    expect(result.item!.description).toContain("Possibly similar to");
    expect(listBacklog()).toHaveLength(2);
  });

  it("compares against triaged rows too, not just the inbox", () => {
    const existing = createBacklogItem({ title: "Tunnel rate limiter" });
    triageBacklogItem(existing.id);
    const result = intakeCapture({
      text: "tunnel rate limiter",
      source: "shortcut",
    });
    expect(result.outcome).toBe("duplicate");
  });

  it("ignores dropped rows when deduping", () => {
    // A dismissed idea shouldn't block re-capturing it later — the user
    // clearly changed their mind.
    const dropped = createBacklogItem({ title: "Tunnel rate limiter" });
    getDb()
      .prepare(`UPDATE backlog_items SET status = 'dropped' WHERE id = ?`)
      .run(dropped.id);
    const result = intakeCapture({
      text: "Tunnel rate limiter",
      source: "shortcut",
    });
    expect(result.outcome).toBe("created");
  });
});

describe("inbox stage", () => {
  it("pre-triages deliberate sources and holds capture channels", () => {
    // Typing into the DryDock UI or the Apple Note is already a
    // considered act on a trusted surface; a five-second channel isn't.
    const manual = createBacklogItem({ title: "typed here", source: "manual" });
    const notes = createBacklogItem({
      title: "typed in notes",
      source: "apple-notes",
    });
    const siri = createBacklogItem({ title: "said to siri", source: "shortcut" });

    expect(manual.triaged_at).not.toBeNull();
    expect(notes.triaged_at).not.toBeNull();
    expect(siri.triaged_at).toBeNull();
    expect(inboxCount()).toBe(1);
  });

  it("accepting promotes a machine proposal to a real idea", () => {
    const proposed = createBacklogItem({
      title: "nightly idea",
      source: "ai-generated",
      status: "proposed",
    });
    expect(proposed.triaged_at).toBeNull();

    const accepted = triageBacklogItem(proposed.id)!;
    expect(accepted.triaged_at).not.toBeNull();
    // Leaving it `proposed` would keep it filtered out of the list it
    // was just promoted into.
    expect(accepted.status).toBe("idea");
    expect(listBacklog({ stage: "triaged" })).toHaveLength(1);
  });

  it("accepting an ordinary capture leaves its status alone", () => {
    const item = createBacklogItem({ title: "said to siri", source: "shortcut" });
    const accepted = triageBacklogItem(item.id)!;
    expect(accepted.status).toBe("idea");
  });

  it("returns null for an unknown id rather than throwing", () => {
    expect(triageBacklogItem("nope")).toBeNull();
  });

  it("stage filters partition the list exactly", () => {
    createBacklogItem({ title: "a", source: "manual" });
    createBacklogItem({ title: "b", source: "shortcut" });
    expect(listBacklog({ stage: "triaged" })).toHaveLength(1);
    expect(listBacklog({ stage: "inbox" })).toHaveLength(1);
    expect(listBacklog()).toHaveLength(2);
  });
});

describe("triage migration", () => {
  it("stamps pre-existing rows so the inbox doesn't swallow the backlog", () => {
    // Adding `triaged_at` to an existing DB would otherwise sweep every
    // item the user already had into an inbox they never filled, forcing
    // them to re-accept the whole list to get back to where they were.
    const item = createBacklogItem({ title: "existing", source: "manual" });
    getDb()
      .prepare(`UPDATE backlog_items SET triaged_at = NULL WHERE id = ?`)
      .run(item.id);
    getDb().prepare(`DELETE FROM settings WHERE key LIKE 'migration.%'`).run();

    // Reopen: the migration runs at connection open.
    const path = process.env.DRYDOCK_DB_PATH;
    _resetDbForTests();
    process.env.DRYDOCK_DB_PATH = path;
    getDb();

    expect(getBacklogItem(item.id)!.triaged_at).toBe(item.created_at);
    expect(inboxCount()).toBe(0);
  });

  it("does not re-stamp genuinely untriaged rows on a later open", () => {
    // The guard that matters: without the "already done" marker, every
    // process restart would silently empty the inbox into the backlog.
    const captured = createBacklogItem({
      title: "said to siri",
      source: "shortcut",
    });
    expect(captured.triaged_at).toBeNull();

    const path = process.env.DRYDOCK_DB_PATH;
    _resetDbForTests();
    process.env.DRYDOCK_DB_PATH = path;
    getDb();

    expect(getBacklogItem(captured.id)!.triaged_at).toBeNull();
    expect(inboxCount()).toBe(1);
  });
});

describe("Apple Notes title-claim (Codex P2, PR #8)", () => {
  it("triages an inbox row when a Note line claims it", async () => {
    // A capture without an idempotency key has a null external_id, so
    // the Notes pull's title-claim fallback could adopt it. Because the
    // push renders triaged rows only, the very next write would DELETE
    // that line from the Note instead of adopting it. A line present in
    // the Note is by definition in the trusted list.
    const { applyPulledLines } = await import("./backlog");
    const { lineId } = await import("../integrations/apple-notes");

    const captured = intakeCapture({
      text: "rate limiter for the tunnel",
      source: "shortcut",
    });
    expect(captured.item!.triaged_at).toBeNull();
    expect(captured.item!.external_id).toBeNull();

    applyPulledLines([
      {
        text: "rate limiter for the tunnel",
        externalId: lineId("rate limiter for the tunnel"),
        done: false,
        createdAt: null,
      },
    ]);

    const claimed = listBacklog().find((i) => i.id === captured.item!.id)!;
    expect(claimed.source).toBe("apple-notes");
    expect(claimed.triaged_at).not.toBeNull();
    // And therefore it survives the next push rather than being deleted.
    expect(listBacklog({ stage: "triaged" })).toHaveLength(1);
  });
});
