import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCodexUsage } from "./codex-usage";

/**
 * Tests the aggregation behaviour against fixture rollout logs in the
 * Codex CLI's documented shape: date-nested dirs (YYYY/MM/DD) holding
 * `rollout-*.jsonl` files whose `token_count` event lines carry a
 * `payload.info.last_token_usage` block.
 *
 * NB: this validates the *parser* against the format we target, not the
 * format against reality — there were no real `~/.codex` sessions to
 * compare against when this was written.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "drydock-codex-usage-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const FIXED_NOW = new Date("2026-05-16T12:00:00.000Z");

interface TurnFixture {
  timestamp: string; // ISO
  input?: number;
  cached?: number;
  output?: number;
  reasoning?: number;
  total?: number;
}

/** A wrapped token_count rollout line. */
function tokenCountLine(t: TurnFixture): string {
  return JSON.stringify({
    timestamp: t.timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: t.input ?? 0,
          cached_input_tokens: t.cached ?? 0,
          output_tokens: t.output ?? 0,
          reasoning_output_tokens: t.reasoning ?? 0,
          total_tokens: t.total ?? 0,
        },
        total_token_usage: {
          // cumulative — intentionally large so a regression that sums the
          // wrong field would be obvious.
          input_tokens: 999999,
          cached_input_tokens: 999999,
          output_tokens: 999999,
          reasoning_output_tokens: 999999,
          total_tokens: 999999,
        },
      },
    },
  });
}

/**
 * Writes a rollout file under YYYY/MM/DD derived from `dateParts`. Each
 * file is one session. Non-token lines (session_meta, response_item) are
 * interleaved to prove they're ignored.
 */
function writeRollout(
  dateParts: [string, string, string],
  fileName: string,
  turns: TurnFixture[],
): void {
  const dir = join(root, ...dateParts);
  mkdirSync(dir, { recursive: true });
  const lines: string[] = [
    JSON.stringify({ timestamp: turns[0]?.timestamp, type: "session_meta", payload: { id: fileName } }),
    JSON.stringify({ timestamp: turns[0]?.timestamp, type: "response_item", payload: { type: "message" } }),
    ...turns.map(tokenCountLine),
  ];
  writeFileSync(join(dir, fileName), lines.join("\n") + "\n");
}

describe("readCodexUsage", () => {
  it("returns zeros for a missing root dir (Codex CLI never run)", async () => {
    const report = await readCodexUsage(join(root, "nope"), FIXED_NOW);
    expect(report.weekly.totalTokens).toBe(0);
    expect(report.weekly.sessions).toBe(0);
    expect(report.monthly.inputTokens).toBe(0);
    expect(report.filesScanned).toBe(0);
    expect(report.latestTurnAt).toBeNull();
  });

  it("sums per-turn last_token_usage across date-nested rollout files", async () => {
    writeRollout(["2026", "05", "15"], "rollout-a.jsonl", [
      { timestamp: "2026-05-15T10:00:00.000Z", input: 100, cached: 50, output: 200, reasoning: 30, total: 380 },
    ]);
    writeRollout(["2026", "05", "15"], "rollout-b.jsonl", [
      { timestamp: "2026-05-15T11:00:00.000Z", input: 1, cached: 2, output: 3, reasoning: 4, total: 10 },
    ]);

    const report = await readCodexUsage(root, FIXED_NOW);
    expect(report.weekly.inputTokens).toBe(101);
    expect(report.weekly.cachedInputTokens).toBe(52);
    expect(report.weekly.outputTokens).toBe(203);
    expect(report.weekly.reasoningOutputTokens).toBe(34);
    expect(report.weekly.totalTokens).toBe(390);
    expect(report.weekly.turns).toBe(2);
    expect(report.weekly.sessions).toBe(2);
    expect(report.filesScanned).toBe(2);
  });

  it("uses last_token_usage, not the cumulative total_token_usage", async () => {
    writeRollout(["2026", "05", "15"], "rollout.jsonl", [
      { timestamp: "2026-05-15T10:00:00.000Z", total: 5 },
      { timestamp: "2026-05-15T10:05:00.000Z", total: 7 },
    ]);
    const report = await readCodexUsage(root, FIXED_NOW);
    // 5 + 7 — not the 999999 cumulative sentinel in total_token_usage.
    expect(report.weekly.totalTokens).toBe(12);
  });

  it("excludes turns older than the rolling 7-day window from weekly", async () => {
    writeRollout(["2026", "05", "06"], "old.jsonl", [
      { timestamp: "2026-05-06T12:00:00.000Z", total: 999 },
    ]);
    writeRollout(["2026", "05", "14"], "new.jsonl", [
      { timestamp: "2026-05-14T12:00:00.000Z", total: 1 },
    ]);
    const report = await readCodexUsage(root, FIXED_NOW);
    expect(report.weekly.totalTokens).toBe(1);
    expect(report.weekly.sessions).toBe(1);
    expect(report.monthly.totalTokens).toBe(1000);
    expect(report.monthly.sessions).toBe(2);
  });

  it("excludes turns before the current calendar month from monthly", async () => {
    writeRollout(["2026", "04", "30"], "april.jsonl", [
      { timestamp: "2026-04-30T23:59:00.000Z", total: 500 },
    ]);
    writeRollout(["2026", "05", "01"], "may.jsonl", [
      { timestamp: "2026-05-01T00:01:00.000Z", total: 7 },
    ]);
    const report = await readCodexUsage(root, FIXED_NOW);
    expect(report.monthly.totalTokens).toBe(7);
    expect(report.monthly.sessions).toBe(1);
  });

  it("tracks the most recent turn across sessions", async () => {
    writeRollout(["2026", "05", "10"], "earlier.jsonl", [
      { timestamp: "2026-05-10T10:00:00.000Z", total: 1 },
    ]);
    writeRollout(["2026", "05", "16"], "later.jsonl", [
      { timestamp: "2026-05-16T08:00:00.000Z", total: 1 },
      { timestamp: "2026-05-15T08:00:00.000Z", total: 1 },
    ]);
    const report = await readCodexUsage(root, FIXED_NOW);
    expect(report.latestTurnAt).toBe("2026-05-16T08:00:00.000Z");
  });

  it("ignores non-token_count lines and survives malformed lines", async () => {
    const dir = join(root, "2026", "05", "15");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "mixed.jsonl"),
      [
        // session meta — no usage
        JSON.stringify({ timestamp: "2026-05-15T10:00:00.000Z", type: "session_meta", payload: {} }),
        // truncated line that mentions token_count (hits fast-path) but won't parse
        '{"type":"event_msg","payload":{"type":"token_count","info":{',
        // valid token_count — counted
        tokenCountLine({ timestamp: "2026-05-15T10:00:02.000Z", input: 42, total: 42 }),
      ].join("\n") + "\n",
    );
    const report = await readCodexUsage(root, FIXED_NOW);
    expect(report.weekly.inputTokens).toBe(42);
    expect(report.weekly.turns).toBe(1);
  });

  it("accepts the unwrapped token_count shape too", async () => {
    const dir = join(root, "2026", "05", "15");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "flat.jsonl"),
      JSON.stringify({
        timestamp: "2026-05-15T10:00:00.000Z",
        type: "token_count",
        info: { last_token_usage: { input_tokens: 9, output_tokens: 1, total_tokens: 10 } },
      }) + "\n",
    );
    const report = await readCodexUsage(root, FIXED_NOW);
    expect(report.weekly.inputTokens).toBe(9);
    expect(report.weekly.totalTokens).toBe(10);
    expect(report.weekly.turns).toBe(1);
  });

  it("dedupes session counts across both windows", async () => {
    writeRollout(["2026", "05", "06"], "sess.jsonl", [
      { timestamp: "2026-05-06T12:00:00.000Z", total: 10 }, // outside weekly
      { timestamp: "2026-05-14T12:00:00.000Z", total: 20 }, // inside weekly
    ]);
    const report = await readCodexUsage(root, FIXED_NOW);
    expect(report.weekly.sessions).toBe(1);
    expect(report.monthly.sessions).toBe(1);
    expect(report.weekly.totalTokens).toBe(20);
    expect(report.monthly.totalTokens).toBe(30);
  });
});
