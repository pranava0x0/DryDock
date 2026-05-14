import { getTask, updateTask, claimTask } from "../db/tasks";
import { getProject } from "../db/projects";
import { createRun, completeRun } from "../db/runs";
import { getBooleanSetting } from "../db/settings";
import { getProvider } from "../providers";
import type { AgentEvent, AgentProvider } from "../providers/types";
import { buildAgentPrompt } from "./prompt";
import { publish } from "./hub";
import {
  createWorktree as defaultCreateWorktree,
  isGitRepo as defaultIsGitRepo,
  removeWorktree as defaultRemoveWorktree,
  type CreateWorktreeInput,
  type CreateWorktreeResult,
} from "./worktree";
import { runQualityGate as defaultRunQualityGate } from "./gate";

/**
 * Settings key for the opt-in auto-cleanup of worktrees on successful runs.
 * When `"true"`, the dispatcher removes the per-task worktree after a
 * successful agent exit (and passing gate, if configured). Defaults to off
 * because Phase 2 explicitly retains worktrees so the user can inspect
 * changes and open a PR manually.
 */
export const AUTO_CLEANUP_WORKTREE_KEY = "auto_cleanup_worktree";

export interface DispatchResult {
  runId: string;
  /**
   * Promise that resolves when the agent subprocess has fully terminated and
   * the run row has been written. Callers can ignore it for fire-and-forget
   * (the HTTP route does); tests await it to assert post-conditions.
   */
  done: Promise<void>;
}

export class DispatchError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "task_not_found"
      | "project_not_found"
      | "already_claimed",
  ) {
    super(message);
    this.name = "DispatchError";
  }
}

/**
 * In-memory map of run id → AbortController. The SSE route uses this to
 * cancel a running agent when the client disconnects (the plan calls out
 * "SSE cleanup — abort subprocess if client disconnects").
 *
 * In-memory is fine because the controller is meaningful only while the
 * Node process that spawned the child is alive — if Next.js restarts, the
 * subprocess is dead anyway and the controller is moot.
 */
const ACTIVE_RUNS = new Map<string, AbortController>();

export function getActiveRunController(runId: string): AbortController | undefined {
  return ACTIVE_RUNS.get(runId);
}

export interface DispatchOptions {
  /**
   * Override the provider lookup. Tests use this to inject a stub provider
   * without going through the real `claude` / `gemini` binary.
   */
  providerFactory?: (name: "claude" | "gemini") => AgentProvider;
  /** Hard timeout in ms; defaults to DRYDOCK_AGENT_TIMEOUT_MS or 10 min. */
  timeoutMs?: number;
  /**
   * Override for git-repo detection. Tests pass a stub to skip shelling
   * out to `git` against a real repo on disk.
   */
  isGitRepo?: (path: string) => Promise<boolean>;
  /**
   * Override for worktree creation. Tests can return a fake worktree dir
   * without touching the real git.
   */
  createWorktree?: (input: CreateWorktreeInput) => Promise<CreateWorktreeResult>;
  /**
   * Override for the quality-gate runner. Tests can return a canned
   * pass/fail result without shelling out to npm test.
   */
  runQualityGate?: (
    command: string,
    cwd: string,
  ) => Promise<{ passed: boolean; exitCode: number; output: string }>;
  /**
   * Override for the worktree teardown call. Tests use it to assert that
   * auto-cleanup actually fires (or doesn't) on success.
   */
  removeWorktree?: (projectPath: string, path: string) => Promise<void>;
  /**
   * Override the auto-cleanup decision. Defaults to reading the
   * `auto_cleanup_worktree` setting from the DB.
   */
  shouldAutoCleanupWorktree?: () => boolean;
}

/**
 * Claim a pending task, spawn the right provider, broadcast its events to
 * the hub, and persist the final outcome.
 *
 * Returns the run id immediately so an HTTP route can respond fast — the
 * `done` promise lets callers await termination when they need to.
 *
 * Throws DispatchError on validation problems so the API route can map them
 * to clean HTTP codes (404 / 409) instead of generic 500s.
 */
export function dispatchTask(
  taskId: string,
  options: DispatchOptions = {},
): DispatchResult {
  const task = getTask(taskId);
  if (!task) {
    throw new DispatchError(`Task not found: ${taskId}`, "task_not_found");
  }
  const project = getProject(task.project_id);
  if (!project) {
    throw new DispatchError(
      `Project not found: ${task.project_id}`,
      "project_not_found",
    );
  }

  const claimed = claimTask(taskId);
  if (!claimed) {
    throw new DispatchError(
      `Task ${taskId} is not pending (likely already claimed)`,
      "already_claimed",
    );
  }

  // Create the run row up front so we have an id to return immediately.
  // Without this, the caller would have to wait for the first agent event
  // before knowing which run to subscribe to.
  const run = createRun(taskId, task.provider);
  updateTask(taskId, { status: "running" });

  const providerFactory = options.providerFactory ?? getProvider;
  const provider = providerFactory(task.provider);
  const controller = new AbortController();
  ACTIVE_RUNS.set(run.id, controller);
  const prompt = buildAgentPrompt(task);
  const timeoutMs = options.timeoutMs ?? agentTimeoutMs();
  const isGitRepoFn = options.isGitRepo ?? defaultIsGitRepo;
  const createWorktreeFn = options.createWorktree ?? defaultCreateWorktree;
  const runQualityGateFn = options.runQualityGate ?? defaultRunQualityGate;
  const removeWorktreeFn = options.removeWorktree ?? defaultRemoveWorktree;
  const shouldAutoCleanupFn =
    options.shouldAutoCleanupWorktree ??
    (() => getBooleanSetting(AUTO_CLEANUP_WORKTREE_KEY, false));

  const done = (async () => {
    // Buffer the full output so we can persist it on completion. The SSE
    // client gets each event live, then `runs.output` ends up with the
    // canonical transcript for replay later.
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    let exitCode: number | null = null;
    let tokensIn: number | null = null;
    let tokensOut: number | null = null;
    let costUsd: number | null = null;
    let gateStatus: "passed" | "failed" | null = null;
    let gateOutput: string | null = null;

    // Determine where the agent runs. By default we isolate every task in
    // its own git worktree so the agent can't mutate the user's working
    // checkout. For non-git project directories (or if worktree creation
    // fails) we fall back to the project path with a visible note.
    let cwd = project.path;
    // Tracks the worktree we created (if any) so the auto-cleanup branch
    // below can call git worktree remove on the same path. Stays null when
    // the project isn't a git repo or when worktree setup failed.
    let createdWorktreePath: string | null = null;
    try {
      if (await isGitRepoFn(project.path)) {
        const wt = await createWorktreeFn({
          projectPath: project.path,
          projectId: project.id,
          taskId: task.id,
          taskTitle: task.title,
        });
        cwd = wt.worktreePath;
        createdWorktreePath = wt.worktreePath;
        updateTask(taskId, {
          branch: wt.branch,
          worktree_path: wt.worktreePath,
        });
        // Surface the isolation info to the live stream so the user sees
        // it before the agent has produced any output of its own.
        publish(run.id, {
          type: "stdout",
          data: `[drydock] worktree ${wt.worktreePath} on branch ${wt.branch}`,
        });
        stdoutLines.push(
          `[drydock] worktree ${wt.worktreePath} on branch ${wt.branch}`,
        );
      } else {
        publish(run.id, {
          type: "stdout",
          data: `[drydock] ${project.path} is not a git repo — agent runs in project dir`,
        });
        stdoutLines.push(
          `[drydock] ${project.path} is not a git repo — agent runs in project dir`,
        );
      }
    } catch (err) {
      // Worktree creation failed (dirty working tree, branch collision,
      // permissions, etc). Tell the user and fall back to the project dir
      // rather than aborting — the agent can still do useful work.
      const message = err instanceof Error ? err.message : String(err);
      publish(run.id, {
        type: "stderr",
        data: `[drydock] worktree setup failed: ${message} — running in project dir`,
      });
      stderrLines.push(`[drydock] worktree setup failed: ${message}`);
    }

    try {
      for await (const event of provider.run(prompt, {
        cwd,
        signal: controller.signal,
        timeoutMs,
      })) {
        if (event.type === "stdout") stdoutLines.push(event.data);
        if (event.type === "stderr") stderrLines.push(event.data);
        if (event.type === "exit") {
          // Capture the agent's exit code but don't publish it — the hub's
          // subscribe() iterator terminates on the first `exit` event, so a
          // publish here would cut off live viewers before they see the
          // quality-gate transcript or worktree-cleanup notes. We synthesize
          // a final terminator at the very end of this block.
          exitCode = event.code ?? null;
          continue;
        }
        if (event.type === "usage") {
          tokensIn = event.tokensIn;
          tokensOut = event.tokensOut;
          costUsd = event.costUsd;
          // Keep the human-readable summary in the transcript too.
          stdoutLines.push(event.data);
        }
        publish(run.id, event);
      }
    } catch (err) {
      // Catastrophic spawn failure that wasn't caught by the provider's own
      // error path — record it so the UI doesn't see a forever-running task.
      const message =
        err instanceof Error ? err.message : String(err);
      stderrLines.push(`dispatch error: ${message}`);
      publish(run.id, { type: "stderr", data: `dispatch error: ${message}` });
      exitCode = -1;
    } finally {
      // Quality gate: only run when the agent itself succeeded AND the
      // project has a `test_command` configured. A failing gate flips
      // success to failure so the user sees a single, decisive verdict.
      let succeeded = exitCode === 0;
      if (succeeded && project.test_command) {
        publish(run.id, {
          type: "stdout",
          data: `[drydock] running quality gate: ${project.test_command}`,
        });
        stdoutLines.push(
          `[drydock] running quality gate: ${project.test_command}`,
        );
        try {
          const gate = await runQualityGateFn(project.test_command, cwd);
          gateStatus = gate.passed ? "passed" : "failed";
          gateOutput = gate.output;
          // Stream the captured gate transcript before the verdict so live
          // viewers can see *why* a gate failed without waiting for the run
          // to terminate and reopening the panel. The replay path pulls the
          // same text out of runs.gate_output on reconnect.
          if (gate.output) {
            publish(run.id, {
              type: gate.passed ? "stdout" : "stderr",
              data: gate.output,
            });
          }
          publish(run.id, {
            type: gate.passed ? "stdout" : "stderr",
            data: gate.passed
              ? `[drydock] quality gate passed`
              : `[drydock] quality gate failed (exit ${gate.exitCode})`,
          });
          if (gate.passed) {
            stdoutLines.push(`[drydock] quality gate passed`);
          } else {
            stderrLines.push(
              `[drydock] quality gate failed (exit ${gate.exitCode})`,
            );
            // Demote the run to failed even though the agent itself exited
            // cleanly — the agent's changes don't pass the user's bar.
            succeeded = false;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          gateStatus = "failed";
          gateOutput = `gate runner error: ${message}`;
          stderrLines.push(`[drydock] quality gate runner error: ${message}`);
          succeeded = false;
        }
      }

      // Auto-cleanup: when the user has opted in, tear down the worktree
      // after a clean success so disk usage doesn't grow with every run.
      // Failures keep the worktree around so the user can still inspect the
      // agent's half-done changes. The branch survives a `git worktree
      // remove`, so the user can still `git checkout` it later if needed.
      if (succeeded && createdWorktreePath && shouldAutoCleanupFn()) {
        try {
          await removeWorktreeFn(project.path, createdWorktreePath);
          updateTask(taskId, { worktree_path: null });
          publish(run.id, {
            type: "stdout",
            data: `[drydock] cleaned up worktree ${createdWorktreePath}`,
          });
          stdoutLines.push(
            `[drydock] cleaned up worktree ${createdWorktreePath}`,
          );
        } catch (err) {
          // Cleanup failure isn't fatal — the run still succeeded. Leave
          // the worktree on disk and tell the user so they can `git
          // worktree remove` by hand.
          const message = err instanceof Error ? err.message : String(err);
          stderrLines.push(
            `[drydock] worktree cleanup failed: ${message}`,
          );
          publish(run.id, {
            type: "stderr",
            data: `[drydock] worktree cleanup failed: ${message}`,
          });
        }
      }

      completeRun(run.id, {
        status: succeeded ? "success" : "failed",
        output: stdoutLines.join("\n"),
        error: stderrLines.length ? stderrLines.join("\n") : null,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        cost_usd: costUsd,
        gate_status: gateStatus,
        gate_output: gateOutput,
      });
      updateTask(taskId, { status: succeeded ? "done" : "failed" });
      // Synthesized terminator: the only `exit` event ever published for
      // this run. Subscribers (SSE clients) terminate here, having seen the
      // agent stream, gate transcript, and cleanup notes in order.
      publish(run.id, {
        type: "exit",
        data: succeeded ? "success" : "failed",
        code: succeeded ? 0 : (exitCode ?? -1),
      });
      ACTIVE_RUNS.delete(run.id);
    }
  })();

  return { runId: run.id, done };
}

function agentTimeoutMs(): number {
  const raw = process.env.DRYDOCK_AGENT_TIMEOUT_MS;
  if (!raw) return 10 * 60 * 1000;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10 * 60 * 1000;
}

export type { AgentEvent };
