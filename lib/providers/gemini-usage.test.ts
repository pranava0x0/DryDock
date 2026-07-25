import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readGeminiUsage } from "./gemini-usage";

/**
 * Tests the aggregation behaviour against fixture step logs. We never read
 * the real `~/.gemini/antigravity/brain` here — every test points
 * readGeminiUsage at a temp dir we built by hand. Fixtures match the line
 * shape observed in the wild: a step event with `source`, `type`,
 * `created_at`, and an optional `tool_calls` array.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "drydock-gemini-usage-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const FIXED_NOW = new Date("2026-05-16T12:00:00.000Z");

/**
 * A CLI-store path that deliberately doesn't exist. Passed explicitly by
 * every test so none of them fall through to the real
 * `~/.gemini/antigravity-cli` and read the developer's own conversations.
 */
const noCliDir = (): string => join(root, "no-agy-cli");

interface StepFixture {
  created_at: string; // ISO
  type?: string; // USER_INPUT | PLANNER_RESPONSE | VIEW_FILE | ...
  source?: string; // USER_EXPLICIT | MODEL | SYSTEM
  toolCalls?: number; // produces a tool_calls array of this length
}

/**
 * Writes a conversation step log. `logName` lets a test pick `overview.txt`
 * (older convos) or `transcript.jsonl` (newer) — both must parse the same.
 */
function writeConversation(
  convId: string,
  steps: StepFixture[],
  logName = "transcript.jsonl",
): void {
  const logsDir = join(root, convId, ".system_generated", "logs");
  mkdirSync(logsDir, { recursive: true });
  const lines = steps.map((s, i) =>
    JSON.stringify({
      step_index: i,
      source: s.source ?? "MODEL",
      type: s.type ?? "PLANNER_RESPONSE",
      status: "DONE",
      created_at: s.created_at,
      ...(s.toolCalls
        ? { tool_calls: Array.from({ length: s.toolCalls }, () => ({ name: "x" })) }
        : {}),
    }),
  );
  writeFileSync(join(logsDir, logName), lines.join("\n") + "\n");
}

describe("readGeminiUsage", () => {
  it("returns zeros for a missing root dir (Antigravity never run)", async () => {
    const report = await readGeminiUsage(join(root, "does-not-exist"), FIXED_NOW, noCliDir());
    expect(report.weekly.modelTurns).toBe(0);
    expect(report.weekly.conversations).toBe(0);
    expect(report.monthly.userPrompts).toBe(0);
    expect(report.conversationsScanned).toBe(0);
    expect(report.latestActivityAt).toBeNull();
  });

  it("counts prompts, model turns and tool calls across conversations", async () => {
    writeConversation("conv-a", [
      { created_at: "2026-05-15T10:00:00Z", type: "USER_INPUT", source: "USER_EXPLICIT" },
      { created_at: "2026-05-15T10:00:05Z", type: "PLANNER_RESPONSE", toolCalls: 3 },
    ]);
    writeConversation("conv-b", [
      { created_at: "2026-05-15T11:00:00Z", type: "USER_INPUT", source: "USER_EXPLICIT" },
      { created_at: "2026-05-15T11:00:05Z", type: "PLANNER_RESPONSE", toolCalls: 1 },
      { created_at: "2026-05-15T11:00:06Z", type: "PLANNER_RESPONSE" },
    ]);

    const report = await readGeminiUsage(root, FIXED_NOW, noCliDir());
    expect(report.weekly.userPrompts).toBe(2);
    expect(report.weekly.modelTurns).toBe(3);
    expect(report.weekly.toolCalls).toBe(4);
    expect(report.weekly.conversations).toBe(2);
    expect(report.conversationsScanned).toBe(2);
  });

  it("excludes steps older than the rolling 7-day window from weekly", async () => {
    writeConversation("old", [
      // 10 days before FIXED_NOW — outside weekly, inside monthly
      { created_at: "2026-05-06T12:00:00Z", type: "PLANNER_RESPONSE", toolCalls: 9 },
    ]);
    writeConversation("new", [
      // 2 days before FIXED_NOW — inside both windows
      { created_at: "2026-05-14T12:00:00Z", type: "PLANNER_RESPONSE", toolCalls: 1 },
    ]);

    const report = await readGeminiUsage(root, FIXED_NOW, noCliDir());
    expect(report.weekly.modelTurns).toBe(1);
    expect(report.weekly.toolCalls).toBe(1);
    expect(report.weekly.conversations).toBe(1);
    expect(report.monthly.modelTurns).toBe(2);
    expect(report.monthly.toolCalls).toBe(10);
    expect(report.monthly.conversations).toBe(2);
  });

  it("excludes steps from before the current calendar month from monthly", async () => {
    writeConversation("april", [
      { created_at: "2026-04-30T23:59:00Z", type: "PLANNER_RESPONSE" },
    ]);
    writeConversation("may", [
      { created_at: "2026-05-01T00:01:00Z", type: "PLANNER_RESPONSE" },
    ]);

    const report = await readGeminiUsage(root, FIXED_NOW, noCliDir());
    expect(report.monthly.modelTurns).toBe(1);
    expect(report.monthly.conversations).toBe(1);
  });

  it("tracks the most recent step across conversations", async () => {
    writeConversation("earlier", [
      { created_at: "2026-05-10T10:00:00Z", type: "PLANNER_RESPONSE" },
    ]);
    writeConversation("later", [
      { created_at: "2026-05-16T08:00:00Z", type: "PLANNER_RESPONSE" },
      { created_at: "2026-05-15T08:00:00Z", type: "PLANNER_RESPONSE" },
    ]);
    const report = await readGeminiUsage(root, FIXED_NOW, noCliDir());
    expect(report.latestActivityAt).toBe("2026-05-16T08:00:00Z");
  });

  it("reads the overview.txt log name as well as transcript.jsonl", async () => {
    writeConversation(
      "legacy",
      [{ created_at: "2026-05-15T10:00:00Z", type: "USER_INPUT", source: "USER_EXPLICIT" }],
      "overview.txt",
    );
    const report = await readGeminiUsage(root, FIXED_NOW, noCliDir());
    expect(report.weekly.userPrompts).toBe(1);
    expect(report.conversationsScanned).toBe(1);
  });

  it("ignores non-conversation dirs that lack a logs folder", async () => {
    // Mimics `tempmediaStorage` — a brain-level dir with no
    // .system_generated/logs. Should be skipped without throwing.
    mkdirSync(join(root, "tempmediaStorage"), { recursive: true });
    writeConversation("real", [
      { created_at: "2026-05-15T10:00:00Z", type: "PLANNER_RESPONSE" },
    ]);
    const report = await readGeminiUsage(root, FIXED_NOW, noCliDir());
    expect(report.conversationsScanned).toBe(1);
    expect(report.weekly.modelTurns).toBe(1);
  });

  it("survives a truncated / malformed line without throwing", async () => {
    const logsDir = join(root, "conv", ".system_generated", "logs");
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(
      join(logsDir, "transcript.jsonl"),
      [
        // looks like a step but is incomplete JSON
        '{"type":"PLANNER_RESPONSE","created_at":"2026-05-15T10:00:00Z"',
        // valid line — should still be counted
        JSON.stringify({
          source: "MODEL",
          type: "PLANNER_RESPONSE",
          created_at: "2026-05-15T10:00:01Z",
          tool_calls: [{ name: "x" }, { name: "y" }],
        }),
      ].join("\n") + "\n",
    );

    const report = await readGeminiUsage(root, FIXED_NOW, noCliDir());
    expect(report.weekly.modelTurns).toBe(1);
    expect(report.weekly.toolCalls).toBe(2);
  });

  it("counts a conversation once per window even with many steps", async () => {
    writeConversation("sess", [
      { created_at: "2026-05-06T12:00:00Z", type: "PLANNER_RESPONSE" }, // outside weekly
      { created_at: "2026-05-14T12:00:00Z", type: "PLANNER_RESPONSE" }, // inside weekly
      { created_at: "2026-05-15T12:00:00Z", type: "PLANNER_RESPONSE" }, // inside weekly
    ]);
    const report = await readGeminiUsage(root, FIXED_NOW, noCliDir());
    expect(report.weekly.conversations).toBe(1);
    expect(report.monthly.conversations).toBe(1);
    expect(report.weekly.modelTurns).toBe(2);
    expect(report.monthly.modelTurns).toBe(3);
  });
});

describe("readGeminiUsage — agy CLI store (DD-BL-38)", () => {
  it("reports the CLI store alongside the IDE windows, never merged", async () => {
    // The IDE brain logs and the CLI's SQLite store are different
    // sources with different confidence. Merging them would hide an
    // unreadable CLI behind healthy IDE numbers.
    writeConversation("conv-1", [
      { created_at: "2026-05-15T10:00:00.000Z", type: "USER_INPUT" },
    ]);
    const cliDir = join(root, "agy-cli");
    mkdirSync(cliDir, { recursive: true });
    const db = new Database(join(cliDir, "c.db"));
    db.prepare(`CREATE TABLE steps (created_at TEXT)`).run();
    db.prepare(`INSERT INTO steps VALUES ('2026-05-15T12:00:00Z')`).run();
    db.close();

    const report = await readGeminiUsage(root, FIXED_NOW, cliDir);
    expect(report.weekly.userPrompts).toBe(1);
    expect(report.cli.health).toBe("ok");
    expect(report.cli.events).toBe(1);
  });

  it("still reports the CLI store when the IDE brain dir is missing", async () => {
    // A CLI-only user previously read as zero activity across the board.
    const cliDir = join(root, "agy-cli");
    mkdirSync(cliDir, { recursive: true });
    const db = new Database(join(cliDir, "c.db"));
    db.prepare(`CREATE TABLE steps (created_at TEXT)`).run();
    db.prepare(`INSERT INTO steps VALUES ('2026-05-15T12:00:00Z')`).run();
    db.close();

    const report = await readGeminiUsage(
      join(root, "does-not-exist"),
      FIXED_NOW,
      cliDir,
    );
    expect(report.weekly.userPrompts).toBe(0);
    expect(report.cli.events).toBe(1);
  });

  it("marks the CLI store unavailable when it isn't installed", async () => {
    const report = await readGeminiUsage(root, FIXED_NOW, noCliDir());
    expect(report.cli.health).toBe("unavailable");
    expect(report.cli.events).toBe(0);
  });
});
