import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetDbForTests, getDb } from "../db/index";
import { createProject } from "../db/projects";
import { createTask } from "../db/tasks";
import { createRun, completeRun } from "../db/runs";
import { replayFromDb, type ReplayPayload } from "./replay";

beforeEach(() => {
  _resetDbForTests();
  const dir = mkdtempSync(join(tmpdir(), "drydock-replay-test-"));
  process.env.DRYDOCK_DB_PATH = join(dir, "test.db");
  getDb();
});

function setupRun(): string {
  const p = createProject({ name: "P", path: "/tmp/p" });
  const t = createTask({ project_id: p.id, title: "x", description: "" });
  return createRun(t.id, "claude").id;
}

describe("replayFromDb", () => {
  it("emits stdout, stderr, gate_output, and exit for a terminal run", () => {
    const runId = setupRun();
    completeRun(runId, {
      status: "failed",
      output: "agent stdout",
      error: "agent stderr",
      gate_status: "failed",
      gate_output: "FAIL src/foo.test.ts",
    });

    const payloads: ReplayPayload[] = [];
    replayFromDb(runId, (p) => payloads.push(p));

    expect(payloads).toHaveLength(4);
    expect(payloads[0]).toEqual({ type: "stdout", data: "agent stdout" });
    expect(payloads[1]).toEqual({ type: "stderr", data: "agent stderr" });
    expect(payloads[2]).toEqual({
      type: "stderr",
      data: "[drydock] quality gate output:\nFAIL src/foo.test.ts",
    });
    expect(payloads[3]).toEqual({ type: "exit", data: "failed", code: -1 });
  });

  it("surfaces gate_output as stdout when the gate passed", () => {
    const runId = setupRun();
    completeRun(runId, {
      status: "success",
      output: "agent did stuff",
      gate_status: "passed",
      gate_output: "tests pass",
    });

    const payloads: ReplayPayload[] = [];
    replayFromDb(runId, (p) => payloads.push(p));

    const gate = payloads.find((p) => p.data.includes("quality gate output"));
    expect(gate?.type).toBe("stdout");
    const exit = payloads.find((p) => p.type === "exit");
    expect(exit).toEqual({ type: "exit", data: "success", code: 0 });
  });

  it("omits gate output when the run had no gate", () => {
    const runId = setupRun();
    completeRun(runId, { status: "success", output: "ok" });

    const payloads: ReplayPayload[] = [];
    replayFromDb(runId, (p) => payloads.push(p));

    expect(payloads.some((p) => p.data.includes("quality gate"))).toBe(false);
  });

  it("is a no-op when the run id doesn't exist", () => {
    const payloads: ReplayPayload[] = [];
    replayFromDb("nope", (p) => payloads.push(p));
    expect(payloads).toEqual([]);
  });

  it("skips the exit event for a still-running run", () => {
    const runId = setupRun();
    // Don't call completeRun — leave status='running'.

    const payloads: ReplayPayload[] = [];
    replayFromDb(runId, (p) => payloads.push(p));

    expect(payloads.find((p) => p.type === "exit")).toBeUndefined();
  });
});
