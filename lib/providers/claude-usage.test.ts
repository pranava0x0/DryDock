import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readClaudeUsage } from "./claude-usage";

/**
 * Tests the aggregation behaviour against fixture jsonl files. We never
 * read the real `~/.claude/projects` here — every test points readClaudeUsage
 * at a temp dir we built up by hand. Test fixtures match the actual line
 * shape we observed in the wild: an `assistant`-typed event with
 * `message.usage.input_tokens` and friends.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "drydock-claude-usage-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const FIXED_NOW = new Date("2026-05-16T12:00:00.000Z");

interface TurnFixture {
  timestamp: string; // ISO
  input?: number;
  output?: number;
  cacheCreate?: number;
  cacheRead?: number;
  type?: string; // default 'assistant'
}

function writeSession(projectName: string, sessionId: string, turns: TurnFixture[]): void {
  const projectDir = join(root, projectName);
  mkdirSync(projectDir, { recursive: true });
  const lines = turns.map((t) =>
    JSON.stringify({
      type: t.type ?? "assistant",
      timestamp: t.timestamp,
      sessionId,
      message: {
        model: "claude-opus-4-7",
        role: "assistant",
        type: "message",
        usage: {
          input_tokens: t.input ?? 0,
          output_tokens: t.output ?? 0,
          cache_creation_input_tokens: t.cacheCreate ?? 0,
          cache_read_input_tokens: t.cacheRead ?? 0,
        },
      },
    }),
  );
  writeFileSync(join(projectDir, `${sessionId}.jsonl`), lines.join("\n") + "\n");
}

describe("readClaudeUsage", () => {
  it("returns zeros for a missing root dir (fresh-install case)", async () => {
    const report = await readClaudeUsage(join(root, "does-not-exist"), FIXED_NOW);
    expect(report.weekly.inputTokens).toBe(0);
    expect(report.weekly.sessions).toBe(0);
    expect(report.monthly.inputTokens).toBe(0);
    expect(report.filesScanned).toBe(0);
    expect(report.latestTurnAt).toBeNull();
  });

  it("sums input + output + both cache token kinds across files", async () => {
    writeSession("-Users-foo-Proj", "sess-a", [
      {
        timestamp: "2026-05-15T10:00:00.000Z",
        input: 100,
        output: 200,
        cacheCreate: 300,
        cacheRead: 400,
      },
    ]);
    writeSession("-Users-foo-Proj", "sess-b", [
      {
        timestamp: "2026-05-15T11:00:00.000Z",
        input: 1,
        output: 2,
        cacheCreate: 3,
        cacheRead: 4,
      },
    ]);

    const report = await readClaudeUsage(root, FIXED_NOW);
    expect(report.weekly.inputTokens).toBe(101);
    expect(report.weekly.outputTokens).toBe(202);
    expect(report.weekly.cacheCreationInputTokens).toBe(303);
    expect(report.weekly.cacheReadInputTokens).toBe(404);
    expect(report.weekly.assistantTurns).toBe(2);
    expect(report.weekly.sessions).toBe(2);
    expect(report.filesScanned).toBe(2);
  });

  it("excludes turns older than the rolling 7-day window from weekly", async () => {
    writeSession("-Users-foo-Proj", "old", [
      // 10 days before FIXED_NOW — outside weekly, inside monthly (May has it)
      { timestamp: "2026-05-06T12:00:00.000Z", input: 999 },
    ]);
    writeSession("-Users-foo-Proj", "new", [
      // 2 days before FIXED_NOW — inside both windows
      { timestamp: "2026-05-14T12:00:00.000Z", input: 1 },
    ]);

    const report = await readClaudeUsage(root, FIXED_NOW);
    expect(report.weekly.inputTokens).toBe(1);
    expect(report.weekly.sessions).toBe(1);
    expect(report.monthly.inputTokens).toBe(1000);
    expect(report.monthly.sessions).toBe(2);
  });

  it("excludes turns from before the current calendar month from monthly", async () => {
    writeSession("-Users-foo-Proj", "april", [
      { timestamp: "2026-04-30T23:59:00.000Z", input: 500 },
    ]);
    writeSession("-Users-foo-Proj", "may", [
      { timestamp: "2026-05-01T00:01:00.000Z", input: 7 },
    ]);

    const report = await readClaudeUsage(root, FIXED_NOW);
    expect(report.monthly.inputTokens).toBe(7);
    expect(report.monthly.sessions).toBe(1);
  });

  it("tracks the most recent assistant turn across sessions", async () => {
    writeSession("-Users-foo-Proj", "earlier", [
      { timestamp: "2026-05-10T10:00:00.000Z", input: 1 },
    ]);
    writeSession("-Users-foo-Proj", "later", [
      { timestamp: "2026-05-16T08:00:00.000Z", input: 1 },
      { timestamp: "2026-05-15T08:00:00.000Z", input: 1 },
    ]);
    const report = await readClaudeUsage(root, FIXED_NOW);
    expect(report.latestTurnAt).toBe("2026-05-16T08:00:00.000Z");
  });

  it("ignores non-assistant lines and lines without a usage block", async () => {
    const projectDir = join(root, "-Users-foo-Proj");
    mkdirSync(projectDir);
    writeFileSync(
      join(projectDir, "mixed.jsonl"),
      [
        // user message — has no usage
        JSON.stringify({
          type: "user",
          timestamp: "2026-05-15T10:00:00.000Z",
          message: { role: "user", content: "hi" },
        }),
        // queue operation — wrong shape
        JSON.stringify({
          type: "queue-operation",
          timestamp: "2026-05-15T10:00:01.000Z",
        }),
        // assistant with usage — counted
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-05-15T10:00:02.000Z",
          message: {
            role: "assistant",
            usage: {
              input_tokens: 42,
              output_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
        }),
      ].join("\n") + "\n",
    );

    const report = await readClaudeUsage(root, FIXED_NOW);
    expect(report.weekly.inputTokens).toBe(42);
    expect(report.weekly.assistantTurns).toBe(1);
  });

  it("survives a truncated / malformed line without throwing", async () => {
    const projectDir = join(root, "-Users-foo-Proj");
    mkdirSync(projectDir);
    writeFileSync(
      join(projectDir, "bad.jsonl"),
      [
        // looks like usage but is incomplete JSON
        '{"type":"assistant","usage":{"input_tokens":1',
        // valid line — should still be counted
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-05-15T10:00:00.000Z",
          message: {
            usage: {
              input_tokens: 5,
              output_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
        }),
      ].join("\n") + "\n",
    );

    const report = await readClaudeUsage(root, FIXED_NOW);
    expect(report.weekly.inputTokens).toBe(5);
    expect(report.weekly.assistantTurns).toBe(1);
  });

  it("dedupes session counts so the same session crossing both windows is counted once per window", async () => {
    // Session has one old turn (outside weekly) and one new turn (inside).
    // Weekly should see sessions=1; monthly should see sessions=1.
    writeSession("-Users-foo-Proj", "sess", [
      { timestamp: "2026-05-06T12:00:00.000Z", input: 10 },
      { timestamp: "2026-05-14T12:00:00.000Z", input: 20 },
    ]);
    const report = await readClaudeUsage(root, FIXED_NOW);
    expect(report.weekly.sessions).toBe(1);
    expect(report.monthly.sessions).toBe(1);
    expect(report.weekly.inputTokens).toBe(20);
    expect(report.monthly.inputTokens).toBe(30);
  });

  it("walks multiple project subdirectories", async () => {
    writeSession("-Users-foo-ProjA", "sess1", [
      { timestamp: "2026-05-15T10:00:00.000Z", input: 1 },
    ]);
    writeSession("-Users-foo-ProjB", "sess2", [
      { timestamp: "2026-05-15T11:00:00.000Z", input: 2 },
    ]);
    const report = await readClaudeUsage(root, FIXED_NOW);
    expect(report.weekly.inputTokens).toBe(3);
    expect(report.weekly.sessions).toBe(2);
    expect(report.filesScanned).toBe(2);
  });
});
