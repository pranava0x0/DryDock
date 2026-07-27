import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readAntigravityCliActivity } from "./antigravity-cli";

/**
 * The real `~/.gemini/antigravity-cli` schema is UNVERIFIED — the
 * directory doesn't exist on the machine this was written against. These
 * fixtures therefore test the *discovery and honesty* behaviour, not
 * fidelity to a known schema: given a plausible database it must count
 * correctly, and given anything it doesn't understand it must say so
 * rather than return a confident zero.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "drydock-agy-cli-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const CUTOFF = new Date("2026-07-18T00:00:00.000Z");

/** Build a fixture database from a list of single SQL statements. */
function makeDb(name: string, statements: string[]): void {
  const db = new Database(join(root, name));
  for (const sql of statements) db.prepare(sql).run();
  db.close();
}

describe("readAntigravityCliActivity", () => {
  it("reports unavailable (not zero) when the CLI has never run", async () => {
    const report = await readAntigravityCliActivity(join(root, "nope"), CUTOFF);
    expect(report.health).toBe("unavailable");
    expect(report.reason).toContain("antigravity-cli");
    expect(report.events).toBe(0);
  });

  it("reports no-data when the directory exists but holds no databases", async () => {
    writeFileSync(join(root, "README.txt"), "not a db");
    const report = await readAntigravityCliActivity(root, CUTOFF);
    expect(report.health).toBe("no-data");
    expect(report.databases).toBe(0);
  });

  it("counts in-window rows from a discovered ISO timestamp column", async () => {
    makeDb("conv-a.db", [
      `CREATE TABLE steps (id INTEGER PRIMARY KEY, created_at TEXT)`,
      `INSERT INTO steps (created_at) VALUES ('2026-07-20T10:00:00.000Z')`,
      `INSERT INTO steps (created_at) VALUES ('2026-07-19T10:00:00.000Z')`,
      `INSERT INTO steps (created_at) VALUES ('2026-07-01T10:00:00.000Z')`,
    ]);

    const report = await readAntigravityCliActivity(root, CUTOFF);
    expect(report.health).toBe("ok");
    expect(report.events).toBe(2);
    expect(report.conversations).toBe(1);
    expect(report.sources).toEqual([
      { database: "conv-a.db", table: "steps", column: "created_at" },
    ]);
  });

  it("classifies epoch milliseconds by magnitude, not by an OR", async () => {
    // The trap: comparing a millisecond value against an epoch-*seconds*
    // cutoff is always true, so a naive `col >= s OR col >= ms` would
    // count the out-of-window row too and report all of history as this
    // week's activity.
    const inWindow = new Date("2026-07-20T00:00:00Z").getTime();
    const outOfWindow = new Date("2026-01-01T00:00:00Z").getTime();
    makeDb("conv-ms.db", [
      `CREATE TABLE events (id INTEGER PRIMARY KEY, timestamp INTEGER)`,
      `INSERT INTO events (timestamp) VALUES (${inWindow})`,
      `INSERT INTO events (timestamp) VALUES (${outOfWindow})`,
    ]);

    const report = await readAntigravityCliActivity(root, CUTOFF);
    expect(report.events).toBe(1);
  });

  it("handles epoch seconds too", async () => {
    const inWindow = Math.floor(
      new Date("2026-07-20T00:00:00Z").getTime() / 1000,
    );
    const outOfWindow = Math.floor(
      new Date("2026-01-01T00:00:00Z").getTime() / 1000,
    );
    makeDb("conv-s.db", [
      `CREATE TABLE events (id INTEGER PRIMARY KEY, created INTEGER)`,
      `INSERT INTO events (created) VALUES (${inWindow})`,
      `INSERT INTO events (created) VALUES (${outOfWindow})`,
    ]);

    const report = await readAntigravityCliActivity(root, CUTOFF);
    expect(report.events).toBe(1);
  });

  it("sums across databases and counts only those with in-window rows", async () => {
    makeDb("a.db", [
      `CREATE TABLE steps (created_at TEXT)`,
      `INSERT INTO steps VALUES ('2026-07-20T00:00:00Z')`,
      `INSERT INTO steps VALUES ('2026-07-21T00:00:00Z')`,
    ]);
    makeDb("b.db", [
      `CREATE TABLE steps (created_at TEXT)`,
      `INSERT INTO steps VALUES ('2026-01-01T00:00:00Z')`,
    ]);

    const report = await readAntigravityCliActivity(root, CUTOFF);
    expect(report.databases).toBe(2);
    expect(report.events).toBe(2);
    expect(report.conversations).toBe(1);
  });

  it("says unavailable when the schema has no recognizable timestamp", async () => {
    // The important case: our guess about the schema was wrong. Saying
    // "unavailable, here's why" is the honest answer; returning 0 events
    // would read as "you didn't use the CLI this week".
    makeDb("weird.db", [
      `CREATE TABLE blobs (id INTEGER PRIMARY KEY, payload BLOB)`,
    ]);

    const report = await readAntigravityCliActivity(root, CUTOFF);
    expect(report.health).toBe("unavailable");
    expect(report.reason).toContain("timestamp");
    expect(report.databases).toBe(1);
    expect(report.events).toBe(0);
  });

  it("skips a corrupt file without failing the whole read", async () => {
    writeFileSync(join(root, "corrupt.db"), "this is not sqlite");
    makeDb("good.db", [
      `CREATE TABLE steps (created_at TEXT)`,
      `INSERT INTO steps VALUES ('2026-07-20T00:00:00Z')`,
    ]);

    const report = await readAntigravityCliActivity(root, CUTOFF);
    expect(report.health).toBe("ok");
    expect(report.events).toBe(1);
  });
});
