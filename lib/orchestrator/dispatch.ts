import {
  getTask,
  updateTask,
  claimTask,
  claimTaskRespectingCap,
  countInFlightTasks,
  nextQueuedTask,
  queuePosition,
} from "../db/tasks";
import { getProject, type Project } from "../db/projects";
import {
  createRun,
  completeRun,
  getLatestRunForTask,
  type FailureReason,
} from "../db/runs";
import { getBooleanSetting, getNumberSetting, getSetting } from "../db/settings";
import { matchRoute, parseRules, ROUTING_RULES_KEY } from "../routing/rules";
import { getProvider } from "../providers";
import type {
  AgentEvent,
  AgentProvider,
  ProviderName,
} from "../providers/types";
import { buildAgentPrompt, buildFollowupPrompt } from "./prompt";
import { publish } from "./hub";
import {
  createWorktree as defaultCreateWorktree,
  isGitRepo as defaultIsGitRepo,
  removeWorktree as defaultRemoveWorktree,
  recreateWorktree as defaultRecreateWorktree,
  worktreeExists as defaultWorktreeExists,
  type CreateWorktreeInput,
  type CreateWorktreeResult,
  type RecreateWorktreeInput,
} from "./worktree";
import { runQualityGate as defaultRunQualityGate } from "./gate";

/**
 * Settings key for the auto-cleanup of worktrees on successful runs. When
 * unset or `"true"`, the dispatcher removes the per-task worktree after a
 * successful agent exit (and passing gate, if configured). Defaults to ON —
 * set it to `"false"` to retain worktrees so you can inspect changes and
 * open a PR manually before cleanup.
 */
export const AUTO_CLEANUP_WORKTREE_KEY = "auto_cleanup_worktree";

/**
 * Settings key for the dispatch concurrency cap. Tasks that would exceed it
 * are queued (status 'queued') and drained FIFO as running tasks finish.
 */
export const MAX_CONCURRENT_RUNS_KEY = "max_concurrent_runs";

export const DEFAULT_MAX_CONCURRENT_RUNS = 3;

export function maxConcurrentRuns(): number {
  const n = getNumberSetting(MAX_CONCURRENT_RUNS_KEY);
  if (n === null) return DEFAULT_MAX_CONCURRENT_RUNS;
  return Math.max(1, Math.floor(n));
}

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

interface ActiveRun {
  controller: AbortController;
  /**
   * Set by cancelActiveRun so the finalizer can distinguish "user hit
   * Stop" from every other abort/kill path when writing failure_reason.
   */
  cancelRequested: boolean;
}

/**
 * In-memory map of run id → live-run state. The cancel route uses this to
 * kill a running agent on demand; the SSE route only checks liveness (a
 * dropped stream connection must NOT kill a healthy run — phone clients
 * disconnect constantly).
 *
 * In-memory is fine because the controller is meaningful only while the
 * Node process that spawned the child is alive — if Next.js restarts, the
 * subprocess is dead anyway and the controller is moot.
 */
const ACTIVE_RUNS = new Map<string, ActiveRun>();

export function getActiveRunController(runId: string): AbortController | undefined {
  return ACTIVE_RUNS.get(runId)?.controller;
}

/**
 * Kill a live run at the user's request. Returns false when the run isn't
 * active anymore (already terminal) — callers treat that as idempotent
 * success, not an error.
 *
 * Scope note: this kills the *agent* subprocess. If the agent had already
 * exited 0 and the quality gate is mid-flight, the cancel arrived too late
 * and the run completes normally — completed work isn't discarded.
 */
export function cancelActiveRun(runId: string): boolean {
  const active = ACTIVE_RUNS.get(runId);
  if (!active) return false;
  active.cancelRequested = true;
  active.controller.abort();
  return true;
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
  /**
   * Internal: the caller (runTaskWithCap) already performed the atomic
   * claim inside its cap transaction — don't claim again. Never set this
   * from a route directly; skipping the claim without having won it breaks
   * the duplicate-dispatch safety net.
   */
  skipClaim?: boolean;
  /** Override worktree-existence check (follow-up path). Tests inject this. */
  worktreeExists?: (projectPath: string, path: string) => Promise<boolean>;
  /** Override worktree re-attach (follow-up path). Tests inject this. */
  recreateWorktree?: (
    input: RecreateWorktreeInput,
  ) => Promise<CreateWorktreeResult>;
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

  if (!options.skipClaim) {
    const claimed = claimTask(taskId);
    if (!claimed) {
      throw new DispatchError(
        `Task ${taskId} is not pending (likely already claimed)`,
        "already_claimed",
      );
    }
  }

  // Build the prompt first so routing rules can match against it.
  const prompt = buildAgentPrompt(task);

  // Apply routing rules. First match wins; no match → use task's stored provider.
  const routingMatch = matchRoute(prompt, parseRules(getSetting(ROUTING_RULES_KEY)));
  const effectiveProvider = routingMatch?.provider ?? task.provider;
  const effectiveModel = routingMatch?.model ?? null;
  const matchedRuleLabel = routingMatch?.ruleLabel ?? null;

  // Create the run row up front so we have an id to return immediately.
  // Without this, the caller would have to wait for the first agent event
  // before knowing which run to subscribe to.
  const run = createRun(taskId, effectiveProvider, { matchedRule: matchedRuleLabel });
  updateTask(taskId, { status: "running" });

  const providerFactory = options.providerFactory ?? getProvider;
  const provider = providerFactory(effectiveProvider);
  const controller = new AbortController();
  const activeRun: ActiveRun = { controller, cancelRequested: false };
  ACTIVE_RUNS.set(run.id, activeRun);
  const isGitRepoFn = options.isGitRepo ?? defaultIsGitRepo;
  const createWorktreeFn = options.createWorktree ?? defaultCreateWorktree;

  const done = runAndFinalize({
    run,
    task,
    project,
    prompt,
    provider,
    controller,
    activeRun,
    timeoutMs: options.timeoutMs ?? agentTimeoutMs(),
    effectiveModel,
    effectiveProvider,
    matchedRuleLabel,
    resumeSessionId: null,
    options,
    resolveWorktree: async ({ stdoutLines, stderrLines }) => {
      // First run of a task: isolate it in a fresh worktree forked from the
      // project's HEAD. Non-git dirs (or a failed setup) fall back to the
      // project path with a visible note — the agent can still work.
      try {
        if (await isGitRepoFn(project.path)) {
          const wt = await createWorktreeFn({
            projectPath: project.path,
            projectId: project.id,
            taskId: task.id,
            taskTitle: task.title,
          });
          updateTask(taskId, { branch: wt.branch, worktree_path: wt.worktreePath });
          emit(run.id, stdoutLines, `[drydock] worktree ${wt.worktreePath} on branch ${wt.branch}`);
          return { cwd: wt.worktreePath, createdWorktreePath: wt.worktreePath };
        }
        emit(run.id, stdoutLines, `[drydock] ${project.path} is not a git repo — agent runs in project dir`);
        return { cwd: project.path, createdWorktreePath: null };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        publish(run.id, {
          type: "stderr",
          data: `[drydock] worktree setup failed: ${message} — running in project dir`,
        });
        stderrLines.push(`[drydock] worktree setup failed: ${message}`);
        return { cwd: project.path, createdWorktreePath: null };
      }
    },
  });

  return { runId: run.id, done };
}

export class FollowupError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "task_not_found"
      | "project_not_found"
      | "not_terminal"
      | "no_session"
      | "empty_prompt",
  ) {
    super(message);
    this.name = "FollowupError";
  }
}

/**
 * Continue a finished task as a follow-up turn — the steering primitive
 * that turns a fire-and-forget task into a thread. Resumes the latest run's
 * provider session (`claude --resume`) in the same worktree so the agent
 * keeps full context, then funnels through the same gate/cleanup/finalize
 * path as a first run.
 *
 * Preconditions (each a distinct FollowupError code the route maps to a
 * clean status):
 *  - task exists and is terminal (done|failed) — can't steer a live run
 *    (mid-run interactivity is a later phase);
 *  - its latest run captured a session_id (claude only today);
 *  - non-empty feedback prompt.
 *
 * The follow-up run does NOT re-run routing rules: steering stays on the
 * parent run's provider so a rule can't silently switch models mid-thread.
 */
export type FollowupResult =
  | { queued: true; position: number }
  | { queued: false; resumed: true; runId: string; done: Promise<void> };

export function followUpTask(
  taskId: string,
  feedback: string,
  options: DispatchOptions = {},
): FollowupResult {
  const task = getTask(taskId);
  if (!task) {
    throw new FollowupError(`Task not found: ${taskId}`, "task_not_found");
  }
  const project = getProject(task.project_id);
  if (!project) {
    throw new FollowupError(
      `Project not found: ${task.project_id}`,
      "project_not_found",
    );
  }
  if (task.status !== "done" && task.status !== "failed") {
    throw new FollowupError(
      `Task ${taskId} is ${task.status}; only a finished task can take a follow-up`,
      "not_terminal",
    );
  }
  const prompt = buildFollowupPrompt(feedback);
  if (!prompt) {
    throw new FollowupError("Follow-up prompt is empty", "empty_prompt");
  }
  const parent = getLatestRunForTask(taskId);
  if (!parent || !parent.session_id) {
    throw new FollowupError(
      `Task ${taskId} has no resumable session (its last run didn't report one)`,
      "no_session",
    );
  }

  // A follow-up spawns a provider subprocess just like /run, so it must
  // honour the concurrency cap rather than starting immediately because it
  // happens to resume a session. Re-arm the task and claim a slot atomically.
  updateTask(taskId, { status: "pending" });
  const outcome = claimTaskRespectingCap(taskId, maxConcurrentRuns());
  if (outcome === "conflict") {
    throw new FollowupError(
      `Task ${taskId} could not be claimed for a follow-up (raced?)`,
      "not_terminal",
    );
  }
  if (outcome === "queued") {
    // No free slot. Fold the feedback into the description so the fresh run
    // the drain eventually starts still carries the ask, and report queued so
    // the caller stops waiting on a runId. A queued follow-up forgoes
    // --resume: once a slot frees the session may be gone, so it re-runs
    // fresh with the accumulated context in the prompt.
    const queuedTask = getTask(taskId);
    if (queuedTask) {
      updateTask(taskId, {
        description: `${queuedTask.description}\n\n## Follow-up\n${feedback.trim()}`,
      });
    }
    return { queued: true, position: queuePosition(taskId) ?? 1 };
  }

  // Claimed a slot — resume the parent session now. Follow-up stays on the
  // parent run's provider; no routing re-match.
  const effectiveProvider: ProviderName = parent.provider;
  const run = createRun(taskId, effectiveProvider, {
    matchedRule: `followup:${parent.id.slice(0, 8)}`,
    parentRunId: parent.id,
  });
  updateTask(taskId, { status: "running" });

  const providerFactory = options.providerFactory ?? getProvider;
  const provider = providerFactory(effectiveProvider);
  const controller = new AbortController();
  const activeRun: ActiveRun = { controller, cancelRequested: false };
  ACTIVE_RUNS.set(run.id, activeRun);
  const worktreeExistsFn = options.worktreeExists ?? defaultWorktreeExists;
  const recreateWorktreeFn = options.recreateWorktree ?? defaultRecreateWorktree;

  const done = runAndFinalize({
    run,
    task,
    project,
    prompt,
    provider,
    controller,
    activeRun,
    timeoutMs: options.timeoutMs ?? agentTimeoutMs(),
    effectiveModel: null,
    effectiveProvider,
    matchedRuleLabel: null,
    resumeSessionId: parent.session_id,
    options,
    resolveWorktree: async ({ stdoutLines, stderrLines }) => {
      // No branch means the first run happened in the project dir (non-git
      // or setup failed) — resume there too; there's nothing to re-attach.
      if (!task.branch) {
        emit(run.id, stdoutLines, `[drydock] resuming in ${project.path}`);
        return { cwd: project.path, createdWorktreePath: null };
      }
      try {
        // Reuse the still-attached worktree if the first run kept it…
        if (
          task.worktree_path &&
          (await worktreeExistsFn(project.path, task.worktree_path))
        ) {
          emit(run.id, stdoutLines, `[drydock] reusing worktree ${task.worktree_path}`);
          // createdWorktreePath left null: a reused worktree is the task's,
          // not this run's to auto-delete — auto-cleanup keeps hands off.
          return { cwd: task.worktree_path, createdWorktreePath: null };
        }
        // …otherwise re-attach one from the (surviving) branch.
        const wt = await recreateWorktreeFn({
          projectPath: project.path,
          projectId: project.id,
          taskId: task.id,
          branch: task.branch,
        });
        updateTask(taskId, { worktree_path: wt.worktreePath });
        emit(
          run.id,
          stdoutLines,
          `[drydock] re-attached worktree ${wt.worktreePath} on branch ${wt.branch}`,
        );
        // This run created the worktree, so on success auto-cleanup may
        // remove it (same lifecycle as a first run).
        return { cwd: wt.worktreePath, createdWorktreePath: wt.worktreePath };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        publish(run.id, {
          type: "stderr",
          data: `[drydock] couldn't re-attach worktree for branch ${task.branch}: ${message} — resuming in project dir`,
        });
        stderrLines.push(`[drydock] worktree re-attach failed: ${message}`);
        return { cwd: project.path, createdWorktreePath: null };
      }
    },
  });

  return { queued: false, resumed: true, runId: run.id, done };
}

/** Push a line to a buffer AND publish it live under one call. */
function emit(runId: string, buffer: string[], line: string): void {
  buffer.push(line);
  publish(runId, { type: "stdout", data: line });
}

interface RunAndFinalizeParams {
  run: { id: string };
  task: { id: string };
  project: Project;
  prompt: string;
  provider: AgentProvider;
  controller: AbortController;
  activeRun: ActiveRun;
  timeoutMs: number;
  effectiveModel: string | null;
  effectiveProvider: ProviderName;
  matchedRuleLabel: string | null;
  resumeSessionId: string | null;
  options: DispatchOptions;
  /**
   * Decide where the agent runs. Owns the worktree setup (create for a
   * first run, reuse/recreate for a follow-up) and may push notes to the
   * buffers. `createdWorktreePath` is the path auto-cleanup should tear
   * down on success, or null to leave in place (project dir, or a reused
   * worktree a follow-up shouldn't delete).
   */
  resolveWorktree: (buffers: {
    stdoutLines: string[];
    stderrLines: string[];
  }) => Promise<{ cwd: string; createdWorktreePath: string | null }>;
}

/**
 * The shared run loop: worktree resolution → agent subprocess → quality
 * gate → auto-cleanup → persist → terminator → queue drain. Both a first
 * dispatch and a follow-up turn funnel through here so the gate/cleanup/
 * cancel/failure-reason semantics stay identical; only worktree resolution
 * and the `--resume` flag differ, which the caller supplies.
 */
function runAndFinalize(params: RunAndFinalizeParams): Promise<void> {
  const {
    run,
    task,
    project,
    prompt,
    provider,
    controller,
    activeRun,
    timeoutMs,
    effectiveModel,
    effectiveProvider,
    matchedRuleLabel,
    resumeSessionId,
    options,
    resolveWorktree,
  } = params;
  const runQualityGateFn = options.runQualityGate ?? defaultRunQualityGate;
  const removeWorktreeFn = options.removeWorktree ?? defaultRemoveWorktree;
  const shouldAutoCleanupFn =
    options.shouldAutoCleanupWorktree ??
    (() => getBooleanSetting(AUTO_CLEANUP_WORKTREE_KEY, true));

  return (async () => {
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    let exitCode: number | null = null;
    let tokensIn: number | null = null;
    let tokensOut: number | null = null;
    let costUsd: number | null = null;
    let sessionId: string | null = null;
    let gateStatus: "passed" | "failed" | null = null;
    let gateOutput: string | null = null;

    const { cwd, createdWorktreePath } = await resolveWorktree({
      stdoutLines,
      stderrLines,
    });

    try {
      if (matchedRuleLabel) {
        const modelNote = effectiveModel ? ` (${effectiveModel})` : "";
        emit(
          run.id,
          stdoutLines,
          `[drydock] routing rule "${matchedRuleLabel}" → ${effectiveProvider}${modelNote}`,
        );
      }
      if (resumeSessionId) {
        emit(run.id, stdoutLines, `[drydock] resuming session ${resumeSessionId}`);
      }
      // Make the blast radius legible in every transcript.
      emit(run.id, stdoutLines, `[drydock] autonomy profile: ${project.autonomy}`);

      for await (const event of provider.run(prompt, {
        cwd,
        signal: controller.signal,
        timeoutMs,
        model: effectiveModel,
        autonomy: project.autonomy,
        resumeSessionId,
      })) {
        if (event.type === "stdout") stdoutLines.push(event.data);
        if (event.type === "stderr") stderrLines.push(event.data);
        if (event.type === "session") {
          // Internal plumbing — capture for --resume, don't forward to SSE.
          sessionId = event.sessionId;
          continue;
        }
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
      const message = err instanceof Error ? err.message : String(err);
      stderrLines.push(`dispatch error: ${message}`);
      publish(run.id, { type: "stderr", data: `dispatch error: ${message}` });
      exitCode = -1;
    } finally {
      // A user cancel only counts if it actually stopped the agent — when
      // the agent had already exited 0, the cancel came too late and the
      // run finishes on its own merits (completed work isn't discarded).
      const cancelled = activeRun.cancelRequested && exitCode !== 0;
      if (cancelled) {
        const note = "[drydock] run cancelled by user";
        stderrLines.push(note);
        publish(run.id, { type: "stderr", data: note });
      }

      // Quality gate: only run when the agent itself succeeded AND the
      // project has a `test_command` configured. A failing gate flips
      // success to failure so the user sees a single, decisive verdict.
      let succeeded = exitCode === 0;
      if (succeeded && project.test_command) {
        emit(
          run.id,
          stdoutLines,
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

      // Auto-cleanup (on by default): tear down the worktree after a clean
      // success so disk usage doesn't grow with every run.
      // Failures keep the worktree around so the user can still inspect the
      // agent's half-done changes. The branch survives a `git worktree
      // remove`, so the user can still `git checkout` it later if needed.
      if (succeeded && createdWorktreePath && shouldAutoCleanupFn()) {
        try {
          await removeWorktreeFn(project.path, createdWorktreePath);
          updateTask(task.id, { worktree_path: null });
          emit(
            run.id,
            stdoutLines,
            `[drydock] cleaned up worktree ${createdWorktreePath}`,
          );
        } catch (err) {
          // Cleanup failure isn't fatal — the run still succeeded. Leave
          // the worktree on disk and tell the user so they can `git
          // worktree remove` by hand.
          const message = err instanceof Error ? err.message : String(err);
          stderrLines.push(`[drydock] worktree cleanup failed: ${message}`);
          publish(run.id, {
            type: "stderr",
            data: `[drydock] worktree cleanup failed: ${message}`,
          });
        }
      }

      // Why the run failed, for analytics and the cancel path. Order
      // matters: an explicit user cancel wins; then "agent exited clean
      // but the gate demoted it"; everything else is an agent exit.
      const failureReason: FailureReason | null = succeeded
        ? null
        : cancelled
          ? "cancelled"
          : exitCode === 0
            ? "gate_failed"
            : "agent_exit";

      completeRun(run.id, {
        status: succeeded ? "success" : "failed",
        output: stdoutLines.join("\n"),
        error: stderrLines.length ? stderrLines.join("\n") : null,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        cost_usd: costUsd,
        gate_status: gateStatus,
        gate_output: gateOutput,
        failure_reason: failureReason,
        // Keep the thread resumable even when this turn died before Claude
        // emitted a fresh session event: a follow-up that fails on a
        // spawn/auth error would otherwise null out the still-valid parent
        // session and force the next follow-up down the no-session fallback.
        session_id: sessionId ?? resumeSessionId,
      });
      updateTask(task.id, { status: succeeded ? "done" : "failed" });
      // Synthesized terminator: the only `exit` event ever published for
      // this run. Subscribers (SSE clients) terminate here, having seen the
      // agent stream, gate transcript, and cleanup notes in order.
      publish(run.id, {
        type: "exit",
        data: succeeded ? "success" : "failed",
        code: succeeded ? 0 : (exitCode ?? -1),
      });
      ACTIVE_RUNS.delete(run.id);
      // This run just freed a concurrency slot — pull the next queued task
      // (if any) into it. Never let a drain problem break run finalization.
      try {
        drainQueue(options);
      } catch (err) {
        console.error("[drydock] queue drain failed:", err);
      }
    }
  })();
}

export type RunOrQueueResult =
  | { queued: true; position: number }
  | ({ queued: false } & DispatchResult);

/**
 * The cap-aware entry point routes use instead of calling dispatchTask
 * directly: claim a slot if one is free, otherwise park the task in the
 * queue. The count-and-claim happens inside one DB transaction so parallel
 * calls can't both squeeze past the cap.
 */
export function runTaskWithCap(
  taskId: string,
  options: DispatchOptions = {},
): RunOrQueueResult {
  const task = getTask(taskId);
  if (!task) {
    throw new DispatchError(`Task not found: ${taskId}`, "task_not_found");
  }
  const outcome = claimTaskRespectingCap(taskId, maxConcurrentRuns());
  if (outcome === "conflict") {
    throw new DispatchError(
      `Task ${taskId} is not pending (likely already claimed)`,
      "already_claimed",
    );
  }
  if (outcome === "queued") {
    return { queued: true, position: queuePosition(taskId) ?? 1 };
  }
  return { queued: false, ...dispatchTask(taskId, { ...options, skipClaim: true }) };
}

/**
 * Dispatch queued tasks while concurrency slots are free. Called from run
 * finalization; also safe to call opportunistically. dispatchTask's own
 * claim (queued → claimed CAS) is the dedupe against concurrent drains.
 *
 * Tasks that turn out to be undispatchable (project gone, etc.) are marked
 * failed rather than left queued — a wedged head would otherwise block the
 * whole queue forever.
 */
function drainQueue(options: DispatchOptions): void {
  const max = maxConcurrentRuns();
  while (countInFlightTasks() < max) {
    const next = nextQueuedTask();
    if (!next) return;
    try {
      dispatchTask(next.id, { ...options, skipClaim: false });
    } catch (err) {
      if (err instanceof DispatchError && err.code === "already_claimed") {
        // Another drain won the claim — re-check capacity and move on.
        continue;
      }
      if (err instanceof DispatchError) {
        updateTask(next.id, { status: "failed" });
        console.error(
          `[drydock] queued task ${next.id} undispatchable (${err.code}) — marked failed`,
        );
        continue;
      }
      throw err;
    }
  }
}

function agentTimeoutMs(): number {
  const raw = process.env.DRYDOCK_AGENT_TIMEOUT_MS;
  if (!raw) return 10 * 60 * 1000;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10 * 60 * 1000;
}

export type { AgentEvent };
