import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetDbForTests, getDb } from "../db/index";
import { createProject } from "../db/projects";
import { createTask, getTask, updateTask } from "../db/tasks";
import { listRunsForTask, getLatestRunForTask } from "../db/runs";
import { setSetting } from "../db/settings";
import {
  dispatchTask,
  followUpTask,
  FollowupError,
  MAX_CONCURRENT_RUNS_KEY,
} from "./dispatch";

/**
 * followUpTask now returns a queued-or-running union (it respects the
 * concurrency cap). These execution tests seed a single task under the
 * default cap, so they always take the running path — narrow to it and fail
 * loudly if a follow-up ever unexpectedly queues.
 */
function runFollowup(
  ...args: Parameters<typeof followUpTask>
): { queued: false; resumed: true; runId: string; done: Promise<void> } {
  const result = followUpTask(...args);
  if (result.queued) {
    throw new Error("expected a running follow-up but it was queued");
  }
  return result;
}
import { _resetHubForTests } from "./hub";
import type {
  AgentEvent,
  AgentProvider,
  AgentRunOptions,
} from "../providers/types";
import type { CreateWorktreeResult, RecreateWorktreeInput } from "./worktree";

beforeEach(() => {
  _resetDbForTests();
  _resetHubForTests();
  const dir = mkdtempSync(join(tmpdir(), "drydock-followup-test-"));
  process.env.DRYDOCK_DB_PATH = join(dir, "test.db");
  getDb();
});

const noGit = async (_path: string): Promise<boolean> => false;
const yesGit = async (_path: string): Promise<boolean> => true;

/** Provider that emits a session id (like claude's init event) then exits. */
function sessionProvider(
  sessionId: string,
  opts: { record?: (o: AgentRunOptions) => void } = {},
): AgentProvider {
  return {
    name: "claude",
    async *run(_prompt: string, options: AgentRunOptions) {
      opts.record?.(options);
      yield { type: "session" as const, sessionId };
      yield { type: "stdout" as const, data: "did the thing" };
      yield {
        type: "usage" as const,
        data: "usage",
        tokensIn: 100,
        tokensOut: 50,
        costUsd: 0.02,
      };
      yield { type: "exit" as const, data: "", code: 0 };
    },
  };
}

/** Run a first dispatch to completion so a resumable session exists. */
async function seedTerminalTaskWithSession(opts: {
  sessionId: string;
  isGitRepo?: (p: string) => Promise<boolean>;
  createWorktree?: () => Promise<CreateWorktreeResult>;
}) {
  const project = createProject({ name: "P", path: "/tmp/p" });
  const task = createTask({
    project_id: project.id,
    title: "build feature",
    description: "the original ask",
  });
  const { done } = dispatchTask(task.id, {
    providerFactory: () => sessionProvider(opts.sessionId),
    isGitRepo: opts.isGitRepo ?? noGit,
    createWorktree: opts.createWorktree,
  });
  await done;
  return { project, task };
}

describe("session capture", () => {
  it("persists the provider session id onto the run row", async () => {
    const { task } = await seedTerminalTaskWithSession({ sessionId: "sess-A" });
    const run = getLatestRunForTask(task.id);
    expect(run?.session_id).toBe("sess-A");
    expect(getTask(task.id)?.status).toBe("done");
  });
});

describe("followUpTask preconditions", () => {
  it("rejects a task that isn't terminal", async () => {
    const project = createProject({ name: "P", path: "/tmp/p" });
    const task = createTask({
      project_id: project.id,
      title: "t",
      description: "d",
    });
    // pending → not terminal
    expect(() => followUpTask(task.id, "keep going")).toThrowError(
      FollowupError,
    );
    try {
      followUpTask(task.id, "keep going");
    } catch (err) {
      expect((err as FollowupError).code).toBe("not_terminal");
    }
  });

  it("rejects a follow-up with an empty prompt", async () => {
    const { task } = await seedTerminalTaskWithSession({ sessionId: "s" });
    try {
      followUpTask(task.id, "   ");
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as FollowupError).code).toBe("empty_prompt");
    }
  });

  it("rejects when the last run captured no session id", async () => {
    const project = createProject({ name: "P", path: "/tmp/p" });
    const task = createTask({
      project_id: project.id,
      title: "t",
      description: "d",
    });
    // A run with no session event (e.g. gemini).
    const { done } = dispatchTask(task.id, {
      providerFactory: () => ({
        name: "gemini",
        async *run() {
          yield { type: "exit" as const, data: "", code: 0 };
        },
      }),
      isGitRepo: noGit,
    });
    await done;
    try {
      followUpTask(task.id, "continue");
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as FollowupError).code).toBe("no_session");
    }
  });

  it("rejects an unknown task", () => {
    try {
      followUpTask("missing", "hi");
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as FollowupError).code).toBe("task_not_found");
    }
  });
});

describe("followUpTask execution", () => {
  it("resumes the parent session and chains the run", async () => {
    const { task } = await seedTerminalTaskWithSession({ sessionId: "sess-A" });
    const parent = getLatestRunForTask(task.id);

    let resumedWith: string | null | undefined;
    const { done } = runFollowup(task.id,"now also update the docs", {
      providerFactory: () =>
        sessionProvider("sess-A", {
          record: (o) => {
            resumedWith = o.resumeSessionId;
          },
        }),
      // No branch on the task (ran in project dir) → resume in project dir.
    });
    await done;

    // The provider was told to --resume the parent's session.
    expect(resumedWith).toBe("sess-A");

    const runs = listRunsForTask(task.id);
    expect(runs).toHaveLength(2);
    const followup = runs.find((r) => r.parent_run_id === parent!.id);
    expect(followup).toBeTruthy();
    expect(followup?.matched_rule).toBe(`followup:${parent!.id.slice(0, 8)}`);
    expect(followup?.provider).toBe("claude");
    expect(getTask(task.id)?.status).toBe("done");
  });

  it("costs accumulate across the whole chain", async () => {
    const { task } = await seedTerminalTaskWithSession({ sessionId: "sess-A" });
    const { done } = runFollowup(task.id,"one more thing", {
      providerFactory: () => sessionProvider("sess-A"),
    });
    await done;
    const runs = listRunsForTask(task.id);
    const total = runs.reduce((sum, r) => sum + (r.cost_usd ?? 0), 0);
    // Two runs at $0.02 each.
    expect(total).toBeCloseTo(0.04, 5);
  });

  it("reuses the still-attached worktree instead of re-creating it", async () => {
    const wt: CreateWorktreeResult = {
      worktreePath: "/tmp/wt/reuse",
      branch: "drydock/abc-build",
    };
    const { task } = await seedTerminalTaskWithSession({
      sessionId: "sess-A",
      isGitRepo: yesGit,
      createWorktree: async () => wt,
    });
    // First run kept its worktree (no auto-clean stub → path stays on task).
    updateTask(task.id, {
      branch: wt.branch,
      worktree_path: wt.worktreePath,
    });

    let ranIn: string | undefined;
    let recreateCalled = false;
    const { done } = runFollowup(task.id,"continue", {
      providerFactory: () => ({
        name: "claude",
        async *run(_p: string, o: AgentRunOptions) {
          ranIn = o.cwd;
          yield { type: "session" as const, sessionId: "sess-A" };
          yield { type: "exit" as const, data: "", code: 0 };
        },
      }),
      worktreeExists: async () => true,
      recreateWorktree: async () => {
        recreateCalled = true;
        return wt;
      },
      shouldAutoCleanupWorktree: () => false,
    });
    await done;
    expect(ranIn).toBe(wt.worktreePath);
    expect(recreateCalled).toBe(false);
  });

  it("re-attaches a worktree from the branch when the original was cleaned", async () => {
    const wt: CreateWorktreeResult = {
      worktreePath: "/tmp/wt/first",
      branch: "drydock/xyz-build",
    };
    const { task } = await seedTerminalTaskWithSession({
      sessionId: "sess-A",
      isGitRepo: yesGit,
      createWorktree: async () => wt,
    });
    // Simulate auto-clean: branch survives, worktree_path cleared.
    updateTask(task.id, { branch: wt.branch, worktree_path: null });

    let ranIn: string | undefined;
    let recreatedFromBranch: string | undefined;
    const recreated: CreateWorktreeResult = {
      worktreePath: "/tmp/wt/reattached",
      branch: wt.branch,
    };
    const { done } = runFollowup(task.id,"resume please", {
      providerFactory: () => ({
        name: "claude",
        async *run(_p: string, o: AgentRunOptions) {
          ranIn = o.cwd;
          yield { type: "session" as const, sessionId: "sess-A" };
          yield { type: "exit" as const, data: "", code: 0 };
        },
      }),
      worktreeExists: async () => false,
      recreateWorktree: async (input: RecreateWorktreeInput) => {
        recreatedFromBranch = input.branch;
        return recreated;
      },
      shouldAutoCleanupWorktree: () => false,
    });
    await done;
    expect(recreatedFromBranch).toBe(wt.branch);
    expect(ranIn).toBe(recreated.worktreePath);
    // The re-attached worktree is now recorded on the task.
    expect(getTask(task.id)?.worktree_path).toBe(recreated.worktreePath);
  });

  it("captures a fresh session id from the follow-up run too", async () => {
    const { task } = await seedTerminalTaskWithSession({ sessionId: "sess-A" });
    const { done } = runFollowup(task.id,"keep going", {
      // Resume may return a rotated session id; we persist whatever we see.
      providerFactory: () => sessionProvider("sess-A-rotated"),
    });
    await done;
    expect(getLatestRunForTask(task.id)?.session_id).toBe("sess-A-rotated");
  });
});

describe("followUpTask concurrency cap", () => {
  it("queues instead of bypassing the cap when no slot is free", async () => {
    setSetting(MAX_CONCURRENT_RUNS_KEY, "1");
    const { task } = await seedTerminalTaskWithSession({ sessionId: "sess-A" });

    // Occupy the only slot with an unrelated in-flight task.
    const busy = createTask({
      project_id: task.project_id,
      title: "busy",
      description: "holds the slot",
    });
    updateTask(busy.id, { status: "running" });

    // The finished task HAS a resumable session — the old bug started it
    // immediately, jumping the queue a /run request would have to wait in.
    const result = followUpTask(task.id, "keep going");
    expect(result.queued).toBe(true);
    expect(getTask(task.id)?.status).toBe("queued");
    // The follow-up ask is folded into the description for the eventual run.
    expect(getTask(task.id)?.description).toContain("keep going");
  });
});
