import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetDbForTests, getDb } from "../db/index";
import { createProject } from "../db/projects";
import {
  claimTaskRespectingCap,
  createTask,
  getTask,
  queuePosition,
  queueTask,
  unqueueTask,
} from "../db/tasks";
import { getLatestRunForTask } from "../db/runs";
import { setSetting } from "../db/settings";
import {
  cancelActiveRun,
  MAX_CONCURRENT_RUNS_KEY,
  maxConcurrentRuns,
  runTaskWithCap,
} from "./dispatch";
import { _resetHubForTests } from "./hub";
import type { AgentProvider, AgentRunOptions } from "../providers/types";

beforeEach(() => {
  _resetDbForTests();
  _resetHubForTests();
  const dir = mkdtempSync(join(tmpdir(), "drydock-cap-test-"));
  process.env.DRYDOCK_DB_PATH = join(dir, "test.db");
  getDb();
});

const noGit = async (_path: string): Promise<boolean> => false;

/**
 * Provider whose exit is held open until the test releases it, so the
 * "slot occupied" window is under test control instead of a race.
 */
function gatedProvider(): {
  provider: AgentProvider;
  release: () => void;
  promptsSeen: string[];
} {
  const promptsSeen: string[] = [];
  let releaseFn: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    releaseFn = resolve;
  });
  return {
    provider: {
      name: "claude",
      async *run(prompt: string) {
        promptsSeen.push(prompt);
        await gate;
        yield { type: "exit" as const, data: "", code: 0 };
      },
    },
    release: () => releaseFn?.(),
    promptsSeen,
  };
}

/** Provider that parks until the abort signal fires, then dies like SIGTERM. */
function abortableProvider(exitCodeOnAbort: number): AgentProvider {
  return {
    name: "claude",
    async *run(_prompt: string, options: AgentRunOptions) {
      yield { type: "stdout" as const, data: "partial output" };
      await new Promise<void>((resolve) => {
        if (options.signal?.aborted) return resolve();
        options.signal?.addEventListener("abort", () => resolve(), {
          once: true,
        });
      });
      yield { type: "exit" as const, data: "SIGTERM", code: exitCodeOnAbort };
    },
  };
}

function makeTask(projectId: string, title: string) {
  return createTask({ project_id: projectId, title, description: "x" });
}

describe("maxConcurrentRuns", () => {
  it("defaults to 3 and clamps garbage to a sane floor", () => {
    expect(maxConcurrentRuns()).toBe(3);
    setSetting(MAX_CONCURRENT_RUNS_KEY, "0");
    expect(maxConcurrentRuns()).toBe(1);
    setSetting(MAX_CONCURRENT_RUNS_KEY, "2.7");
    expect(maxConcurrentRuns()).toBe(2);
    setSetting(MAX_CONCURRENT_RUNS_KEY, "not-a-number");
    expect(maxConcurrentRuns()).toBe(3);
  });
});

describe("queue transitions (DB invariants)", () => {
  it("queueTask CAS: only a pending task can be queued", () => {
    const p = createProject({ name: "P", path: "/tmp/p" });
    const t = makeTask(p.id, "q");
    expect(queueTask(t.id)).toBe(true);
    expect(queueTask(t.id)).toBe(false); // already queued
    expect(getTask(t.id)?.status).toBe("queued");
  });

  it("unqueueTask CAS: only a queued task can go back to pending", () => {
    const p = createProject({ name: "P", path: "/tmp/p" });
    const t = makeTask(p.id, "q");
    expect(unqueueTask(t.id)).toBe(false); // still pending
    queueTask(t.id);
    expect(unqueueTask(t.id)).toBe(true);
    expect(getTask(t.id)?.status).toBe("pending");
  });

  it("claimTaskRespectingCap queues at the cap and reports position", () => {
    const p = createProject({ name: "P", path: "/tmp/p" });
    const a = makeTask(p.id, "a");
    const b = makeTask(p.id, "b");
    const c = makeTask(p.id, "c");
    expect(claimTaskRespectingCap(a.id, 1)).toBe("claimed");
    expect(claimTaskRespectingCap(b.id, 1)).toBe("queued");
    expect(claimTaskRespectingCap(c.id, 1)).toBe("queued");
    expect(queuePosition(b.id)).toBe(1);
    expect(queuePosition(c.id)).toBe(2);
    expect(queuePosition(a.id)).toBeNull();
  });

  it("claimTaskRespectingCap is idempotent for an already-queued task", () => {
    const p = createProject({ name: "P", path: "/tmp/p" });
    const a = makeTask(p.id, "a");
    const b = makeTask(p.id, "b");
    expect(claimTaskRespectingCap(a.id, 1)).toBe("claimed");
    expect(claimTaskRespectingCap(b.id, 1)).toBe("queued");
    expect(claimTaskRespectingCap(b.id, 1)).toBe("queued");
    expect(claimTaskRespectingCap(a.id, 1)).toBe("conflict"); // already claimed
  });
});

describe("runTaskWithCap", () => {
  it("dispatches under the cap, queues at the cap, drains FIFO on finish", async () => {
    setSetting(MAX_CONCURRENT_RUNS_KEY, "1");
    const p = createProject({ name: "P", path: "/tmp/p" });
    const first = makeTask(p.id, "first-task");
    const second = makeTask(p.id, "second-task");
    const third = makeTask(p.id, "third-task");

    const gate1 = gatedProvider();
    const r1 = runTaskWithCap(first.id, {
      providerFactory: () => gate1.provider,
      isGitRepo: noGit,
    });
    expect(r1.queued).toBe(false);

    // Cap is full — both of these must park, in order.
    const r2 = runTaskWithCap(second.id, {
      providerFactory: () => gate1.provider,
      isGitRepo: noGit,
    });
    const r3 = runTaskWithCap(third.id, {
      providerFactory: () => gate1.provider,
      isGitRepo: noGit,
    });
    expect(r2).toEqual({ queued: true, position: 1 });
    expect(r3).toEqual({ queued: true, position: 2 });
    expect(getTask(second.id)?.status).toBe("queued");

    // Finishing the running task must pull the whole queue through, FIFO.
    gate1.release();
    if (!r1.queued) await r1.done;
    // The drain dispatches second-task with the same gated provider; keep
    // releasing until the chain settles.
    await waitFor(() => getTask(third.id)?.status === "done");
    expect(getTask(second.id)?.status).toBe("done");
    // FIFO order: prompts contain the task titles in queue order.
    expect(gate1.promptsSeen.map(titleIn)).toEqual([
      "first-task",
      "second-task",
      "third-task",
    ]);
  });

  it("a burst of calls cannot squeeze past the cap", () => {
    setSetting(MAX_CONCURRENT_RUNS_KEY, "2");
    const p = createProject({ name: "P", path: "/tmp/p" });
    const gate = gatedProvider();
    const results = ["a", "b", "c", "d", "e"].map((title) =>
      runTaskWithCap(makeTask(p.id, title).id, {
        providerFactory: () => gate.provider,
        isGitRepo: noGit,
      }),
    );
    const dispatched = results.filter((r) => !r.queued);
    const queued = results.filter((r) => r.queued);
    expect(dispatched).toHaveLength(2);
    expect(queued).toHaveLength(3);
    gate.release();
  });

  it("unsticks a queued task when capacity is free (post-restart path)", async () => {
    const p = createProject({ name: "P", path: "/tmp/p" });
    const t = makeTask(p.id, "stuck");
    queueTask(t.id); // simulates a queued row surviving a server restart
    const gate = gatedProvider();
    const r = runTaskWithCap(t.id, {
      providerFactory: () => gate.provider,
      isGitRepo: noGit,
    });
    expect(r.queued).toBe(false);
    gate.release();
    if (!r.queued) await r.done;
    expect(getTask(t.id)?.status).toBe("done");
  });
});

describe("cancel", () => {
  it("cancel mid-run: partial output persists, failure_reason='cancelled'", async () => {
    const p = createProject({ name: "P", path: "/tmp/p" });
    const t = makeTask(p.id, "long-runner");
    const r = runTaskWithCap(t.id, {
      providerFactory: () => abortableProvider(-1),
      isGitRepo: noGit,
    });
    expect(r.queued).toBe(false);
    if (r.queued) throw new Error("unreachable");

    await waitFor(() => getLatestRunForTask(t.id) !== null);
    expect(cancelActiveRun(r.runId)).toBe(true);
    await r.done;

    const run = getLatestRunForTask(t.id);
    expect(run?.status).toBe("failed");
    expect(run?.failure_reason).toBe("cancelled");
    expect(run?.output).toContain("partial output");
    expect(run?.error).toContain("cancelled by user");
    expect(getTask(t.id)?.status).toBe("failed");
  });

  it("cancel after completion is an idempotent no-op", async () => {
    const p = createProject({ name: "P", path: "/tmp/p" });
    const t = makeTask(p.id, "quick");
    const gate = gatedProvider();
    const r = runTaskWithCap(t.id, {
      providerFactory: () => gate.provider,
      isGitRepo: noGit,
    });
    if (r.queued) throw new Error("unreachable");
    gate.release();
    await r.done;
    expect(cancelActiveRun(r.runId)).toBe(false);
    expect(getLatestRunForTask(t.id)?.status).toBe("success");
  });

  it("cancel that lands after a clean exit does not discard completed work", async () => {
    const p = createProject({ name: "P", path: "/tmp/p" });
    const t = makeTask(p.id, "too-late");
    // Abort resolves the provider's wait, but the agent still exits 0 —
    // modelling a cancel that arrives as the agent finishes.
    const r = runTaskWithCap(t.id, {
      providerFactory: () => abortableProvider(0),
      isGitRepo: noGit,
    });
    if (r.queued) throw new Error("unreachable");
    await waitFor(() => getLatestRunForTask(t.id) !== null);
    cancelActiveRun(r.runId);
    await r.done;

    const run = getLatestRunForTask(t.id);
    expect(run?.status).toBe("success");
    expect(run?.failure_reason).toBeNull();
    expect(getTask(t.id)?.status).toBe("done");
  });

  it("gate demotion records failure_reason='gate_failed'", async () => {
    const p = createProject({
      name: "P",
      path: "/tmp/p",
      test_command: "npm test",
    });
    const t = makeTask(p.id, "gated");
    const gate = gatedProvider();
    const r = runTaskWithCap(t.id, {
      providerFactory: () => gate.provider,
      isGitRepo: noGit,
      runQualityGate: async () => ({
        passed: false,
        exitCode: 1,
        output: "1 test failed",
      }),
    });
    if (r.queued) throw new Error("unreachable");
    gate.release();
    await r.done;
    const run = getLatestRunForTask(t.id);
    expect(run?.status).toBe("failed");
    expect(run?.failure_reason).toBe("gate_failed");
  });
});

describe("autonomy pass-through", () => {
  it("provider receives the project's autonomy level and the transcript notes it", async () => {
    const p = createProject({
      name: "P",
      path: "/tmp/p",
      autonomy: "readonly",
    });
    const t = makeTask(p.id, "analyze");
    let seen: string | undefined;
    const provider: AgentProvider = {
      name: "claude",
      async *run(_prompt: string, options: AgentRunOptions) {
        seen = options.autonomy;
        yield { type: "exit" as const, data: "", code: 0 };
      },
    };
    const r = runTaskWithCap(t.id, {
      providerFactory: () => provider,
      isGitRepo: noGit,
    });
    if (r.queued) throw new Error("unreachable");
    await r.done;
    expect(seen).toBe("readonly");
    expect(getLatestRunForTask(t.id)?.output).toContain(
      "autonomy profile: readonly",
    );
  });
});

/** Extract the task title back out of a built agent prompt. */
function titleIn(prompt: string): string {
  for (const title of ["first-task", "second-task", "third-task"]) {
    if (prompt.includes(title)) return title;
  }
  return prompt;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor: condition not met in time");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
