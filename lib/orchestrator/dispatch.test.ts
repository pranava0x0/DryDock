import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetDbForTests, getDb } from "../db/index";
import { createProject } from "../db/projects";
import {
  claimTask,
  createTask,
  getTask,
  type TaskStatus,
} from "../db/tasks";
import {
  getLatestRunForTask,
  listRunsForTask,
} from "../db/runs";
import {
  dispatchTask,
  DispatchError,
  getActiveRunController,
} from "./dispatch";
import { _resetHubForTests, subscribe } from "./hub";
import type { AgentEvent, AgentProvider, AgentRunOptions } from "../providers/types";
import type { CreateWorktreeInput, CreateWorktreeResult } from "./worktree";

beforeEach(() => {
  _resetDbForTests();
  _resetHubForTests();
  const dir = mkdtempSync(join(tmpdir(), "drydock-dispatch-test-"));
  process.env.DRYDOCK_DB_PATH = join(dir, "test.db");
  getDb();
});

/** A canned provider that yields a fixed sequence of events. */
function stubProvider(
  name: "claude" | "gemini",
  events: AgentEvent[],
): AgentProvider {
  return {
    name,
    async *run() {
      for (const e of events) yield e;
    },
  };
}

/**
 * Stub provider that records the cwd it was invoked with so tests can
 * assert the dispatcher pointed it at the worktree (not the project dir).
 */
function recordingProvider(): {
  provider: AgentProvider;
  lastCwd: () => string | undefined;
} {
  let cwd: string | undefined;
  return {
    provider: {
      name: "claude",
      async *run(_prompt: string, options: AgentRunOptions) {
        cwd = options.cwd;
        yield { type: "exit", data: "", code: 0 };
      },
    },
    lastCwd: () => cwd,
  };
}

/** No-git stub: dispatch falls back to the project dir. */
const noGit = async (_path: string): Promise<boolean> => false;
const yesGit = async (_path: string): Promise<boolean> => true;

describe("dispatchTask", () => {
  it("end-to-end: claims, runs, persists output, marks task done", async () => {
    const p = createProject({ name: "P", path: "/tmp/p" });
    const t = createTask({
      project_id: p.id,
      title: "do thing",
      description: "details",
    });

    const provider = stubProvider("claude", [
      { type: "stdout", data: "hello" },
      { type: "stdout", data: "world" },
      { type: "exit", data: "", code: 0 },
    ]);

    const { runId, done } = dispatchTask(t.id, {
      providerFactory: () => provider,
      isGitRepo: noGit,
    });
    await done;

    const task = getTask(t.id);
    expect(task?.status).toBe<TaskStatus>("done");
    const run = getLatestRunForTask(t.id);
    expect(run?.id).toBe(runId);
    expect(run?.status).toBe("success");
    // The output now includes a leading `[drydock] ... not a git repo ...`
    // note. The agent's lines should follow.
    expect(run?.output).toMatch(/hello\nworld/);
    expect(run?.error).toBeNull();
  });

  it("marks task failed when the provider exits non-zero", async () => {
    const p = createProject({ name: "P", path: "/tmp/p" });
    const t = createTask({
      project_id: p.id,
      title: "boom",
      description: "x",
    });
    const provider = stubProvider("claude", [
      { type: "stderr", data: "bad thing" },
      { type: "exit", data: "", code: 1 },
    ]);

    const { done } = dispatchTask(t.id, {
      providerFactory: () => provider,
      isGitRepo: noGit,
    });
    await done;

    const task = getTask(t.id);
    expect(task?.status).toBe<TaskStatus>("failed");
    const run = getLatestRunForTask(t.id);
    expect(run?.status).toBe("failed");
    expect(run?.error).toBe("bad thing");
  });

  it("rejects with already_claimed when task isn't pending", () => {
    const p = createProject({ name: "P", path: "/tmp/p" });
    const t = createTask({
      project_id: p.id,
      title: "race",
      description: "x",
    });
    // Pre-claim it to simulate another dispatcher winning.
    expect(claimTask(t.id)).toBe(true);

    expect(() =>
      dispatchTask(t.id, {
        providerFactory: () => stubProvider("claude", []),
      }),
    ).toThrowError(DispatchError);
  });

  it("rejects with task_not_found for unknown id", () => {
    try {
      dispatchTask("missing", {
        providerFactory: () => stubProvider("claude", []),
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DispatchError);
      expect((err as DispatchError).code).toBe("task_not_found");
    }
  });

  it("subscribers see events as they're published", async () => {
    const p = createProject({ name: "P", path: "/tmp/p" });
    const t = createTask({
      project_id: p.id,
      title: "stream",
      description: "x",
    });
    const provider = stubProvider("claude", [
      { type: "stdout", data: "first" },
      { type: "exit", data: "", code: 0 },
    ]);

    const { runId, done } = dispatchTask(t.id, {
      providerFactory: () => provider,
      isGitRepo: noGit,
    });
    await done;

    // After the run completes the hub still has the buffered transcript.
    // The first event is the [drydock] no-git-repo note, then "first", then exit.
    const received: AgentEvent[] = [];
    for await (const e of subscribe(runId)) received.push(e);
    expect(received).toHaveLength(3);
    expect(received[0]).toMatchObject({ type: "stdout" });
    expect(received[0].data).toMatch(/not a git repo/);
    expect(received[1]).toEqual({ type: "stdout", data: "first" });
    expect(received[2]).toEqual({ type: "exit", data: "", code: 0 });

    // And there's exactly one run row for this task.
    expect(listRunsForTask(t.id)).toHaveLength(1);
  });

  it("clears the active-run controller after completion", async () => {
    const p = createProject({ name: "P", path: "/tmp/p" });
    const t = createTask({
      project_id: p.id,
      title: "cleanup",
      description: "x",
    });
    const provider = stubProvider("claude", [
      { type: "exit", data: "", code: 0 },
    ]);
    const { runId, done } = dispatchTask(t.id, {
      providerFactory: () => provider,
      isGitRepo: noGit,
    });
    // Controller is present while the run is in flight.
    expect(getActiveRunController(runId)).toBeDefined();
    await done;
    // Once done, the controller is released so stale subscriptions don't
    // try to abort a long-finished subprocess.
    expect(getActiveRunController(runId)).toBeUndefined();
  });

  it("records output even when no one subscribes (fire-and-forget)", async () => {
    const p = createProject({ name: "P", path: "/tmp/p" });
    const t = createTask({
      project_id: p.id,
      title: "headless",
      description: "x",
    });
    const provider = stubProvider("claude", [
      { type: "stdout", data: "lonely tree" },
      { type: "exit", data: "", code: 0 },
    ]);
    const { done } = dispatchTask(t.id, {
      providerFactory: () => provider,
      isGitRepo: noGit,
    });
    await done;
    const run = getLatestRunForTask(t.id);
    expect(run?.output).toMatch(/lonely tree/);
    expect(run?.status).toBe("success");
  });

  it("creates an isolated worktree and points the agent at it (Phase 2)", async () => {
    const p = createProject({ name: "P", path: "/tmp/p" });
    const t = createTask({
      project_id: p.id,
      title: "Add dark mode",
      description: "x",
    });

    const { provider, lastCwd } = recordingProvider();
    const fakeWorktreePath = "/tmp/drydock-fake-worktree";
    const fakeBranch = "drydock/12345678-add-dark-mode";
    const createWorktree = async (
      input: CreateWorktreeInput,
    ): Promise<CreateWorktreeResult> => {
      // Sanity check: dispatcher forwards the right project + task context.
      expect(input.projectPath).toBe("/tmp/p");
      expect(input.taskId).toBe(t.id);
      expect(input.taskTitle).toBe("Add dark mode");
      return { worktreePath: fakeWorktreePath, branch: fakeBranch };
    };

    const { done } = dispatchTask(t.id, {
      providerFactory: () => provider,
      isGitRepo: yesGit,
      createWorktree,
    });
    await done;

    // The agent was invoked with the worktree path, not the project path.
    expect(lastCwd()).toBe(fakeWorktreePath);

    // The task row now records the branch and worktree path so the UI can
    // surface them and so a later PR-creation step can target the branch.
    const task = getTask(t.id);
    expect(task?.branch).toBe(fakeBranch);
    expect(task?.worktree_path).toBe(fakeWorktreePath);
    expect(task?.status).toBe<TaskStatus>("done");

    // The transcript leads with the [drydock] worktree note so the user
    // knows where the agent operated.
    const run = getLatestRunForTask(t.id);
    expect(run?.output).toMatch(/\[drydock\] worktree .* on branch drydock\//);
  });

  it("runs the project's quality gate after a successful agent exit (Phase 3)", async () => {
    const p = createProject({
      name: "P",
      path: "/tmp/p",
      test_command: "npm test",
    });
    const t = createTask({
      project_id: p.id,
      title: "with gate",
      description: "x",
    });
    const provider = stubProvider("claude", [
      { type: "stdout", data: "agent says ok" },
      { type: "exit", data: "", code: 0 },
    ]);
    const gateCalls: Array<{ command: string; cwd: string }> = [];
    const runQualityGate = async (command: string, cwd: string) => {
      gateCalls.push({ command, cwd });
      return { passed: true, exitCode: 0, output: "All tests pass" };
    };

    const { done } = dispatchTask(t.id, {
      providerFactory: () => provider,
      isGitRepo: noGit,
      runQualityGate,
    });
    await done;

    // Gate ran with the configured command in the same cwd the agent used.
    expect(gateCalls).toHaveLength(1);
    expect(gateCalls[0].command).toBe("npm test");
    expect(gateCalls[0].cwd).toBe("/tmp/p");

    const task = getTask(t.id);
    expect(task?.status).toBe<TaskStatus>("done");
    const run = getLatestRunForTask(t.id);
    expect(run?.gate_status).toBe("passed");
    expect(run?.gate_output).toBe("All tests pass");
  });

  it("demotes a successful agent run to failed when the gate fails (Phase 3)", async () => {
    const p = createProject({
      name: "P",
      path: "/tmp/p",
      test_command: "npm test",
    });
    const t = createTask({
      project_id: p.id,
      title: "broken patch",
      description: "x",
    });
    const provider = stubProvider("claude", [
      { type: "exit", data: "", code: 0 },
    ]);
    const runQualityGate = async () => ({
      passed: false,
      exitCode: 1,
      output: "2 tests failed",
    });

    const { done } = dispatchTask(t.id, {
      providerFactory: () => provider,
      isGitRepo: noGit,
      runQualityGate,
    });
    await done;

    const task = getTask(t.id);
    expect(task?.status).toBe<TaskStatus>("failed");
    const run = getLatestRunForTask(t.id);
    expect(run?.gate_status).toBe("failed");
    expect(run?.status).toBe("failed");
  });

  it("skips the gate when the agent itself failed (Phase 3)", async () => {
    const p = createProject({
      name: "P",
      path: "/tmp/p",
      test_command: "npm test",
    });
    const t = createTask({
      project_id: p.id,
      title: "agent boom",
      description: "x",
    });
    const provider = stubProvider("claude", [
      { type: "exit", data: "", code: 1 },
    ]);
    let gateCalls = 0;
    const runQualityGate = async () => {
      gateCalls += 1;
      return { passed: true, exitCode: 0, output: "" };
    };

    const { done } = dispatchTask(t.id, {
      providerFactory: () => provider,
      isGitRepo: noGit,
      runQualityGate,
    });
    await done;

    // Running tests against a half-finished agent change isn't meaningful.
    expect(gateCalls).toBe(0);
    const run = getLatestRunForTask(t.id);
    expect(run?.gate_status).toBeNull();
  });

  it("persists usage info when the provider emits a usage event (Phase 3)", async () => {
    const p = createProject({ name: "P", path: "/tmp/p" });
    const t = createTask({
      project_id: p.id,
      title: "costed",
      description: "x",
    });
    const provider = stubProvider("claude", [
      { type: "stdout", data: "hello" },
      {
        type: "usage",
        data: "[drydock] usage — in 100, out 200, $0.0042",
        tokensIn: 100,
        tokensOut: 200,
        costUsd: 0.0042,
      },
      { type: "exit", data: "", code: 0 },
    ]);

    const { done } = dispatchTask(t.id, {
      providerFactory: () => provider,
      isGitRepo: noGit,
    });
    await done;

    const run = getLatestRunForTask(t.id);
    expect(run?.tokens_in).toBe(100);
    expect(run?.tokens_out).toBe(200);
    expect(run?.cost_usd).toBeCloseTo(0.0042, 6);
  });

  it("falls back to project dir when worktree setup throws", async () => {
    const p = createProject({ name: "P", path: "/tmp/p" });
    const t = createTask({
      project_id: p.id,
      title: "broken worktree",
      description: "x",
    });

    const { provider, lastCwd } = recordingProvider();
    const createWorktree = async (): Promise<CreateWorktreeResult> => {
      throw new Error("simulated git failure");
    };

    const { done } = dispatchTask(t.id, {
      providerFactory: () => provider,
      isGitRepo: yesGit,
      createWorktree,
    });
    await done;

    // Fallback: agent runs in the project dir, not in a worktree.
    expect(lastCwd()).toBe("/tmp/p");
    const task = getTask(t.id);
    expect(task?.branch).toBeNull();
    expect(task?.worktree_path).toBeNull();
    // The stderr text recorded on the run row tells the user why.
    const run = getLatestRunForTask(t.id);
    expect(run?.error).toMatch(/worktree setup failed: simulated git failure/);
    // Task still completes successfully (the stub agent exits 0).
    expect(task?.status).toBe<TaskStatus>("done");
  });
});
