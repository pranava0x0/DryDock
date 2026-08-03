import type { NextRequest } from "next/server";
import {
  followUpTask,
  runTaskWithCap,
  FollowupError,
} from "@/lib/orchestrator/dispatch";
import { badRequest, conflict, notFound, ok, serverError } from "@/lib/api/json";
import { rejectRemoteDispatch } from "@/lib/api/local-only";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Continue a finished task as a follow-up turn — the steer primitive.
 * Resumes the last run's session (`claude --resume`) with the user's
 * feedback in the same worktree, returning the new run id to subscribe to.
 *
 * When the task can't be resumed (no session id — e.g. a gemini run, or a
 * run that died before reporting one), the route falls back to a fresh
 * capped dispatch with the feedback appended so the button still does
 * something useful, and flags `resumed:false` so the UI can say so rather
 * than pretending a continuation happened.
 */
export async function POST(
  request: NextRequest,
  ctx: RouteContext,
): Promise<Response> {
  const localOnly = rejectRemoteDispatch(request);
  if (localOnly) return localOnly;
  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("Request body must be valid JSON");
  }
  const prompt =
    typeof (body as Record<string, unknown>)?.prompt === "string"
      ? ((body as Record<string, unknown>).prompt as string)
      : "";
  if (!prompt.trim()) return badRequest("`prompt` is required");

  try {
    const result = followUpTask(id, prompt);
    if (result.queued) {
      return ok({ queued: true, position: result.position, resumed: false });
    }
    result.done.catch(() => {});
    return ok({ runId: result.runId, resumed: true });
  } catch (err) {
    if (err instanceof FollowupError) {
      if (err.code === "task_not_found" || err.code === "project_not_found") {
        return notFound(err.message);
      }
      if (err.code === "not_terminal") return conflict(err.message);
      if (err.code === "empty_prompt") return badRequest(err.message);
      // no_session → the task can't be resumed. Fall back to a fresh run
      // carrying the feedback, but only for a failed task (a done task with
      // no session is unusual; don't silently re-run finished work).
      if (err.code === "no_session") {
        return await freshFallback(id, prompt);
      }
    }
    return serverError((err as Error).message);
  }
}

/**
 * When there's no session to resume, fold the feedback into the task's
 * description (so it's visible and the next dispatch picks it up via
 * buildAgentPrompt), re-arm the task, and run it through the normal
 * cap-aware path. Only for a failed task — we don't silently re-run work
 * that already finished cleanly.
 */
async function freshFallback(taskId: string, prompt: string): Promise<Response> {
  const { getTask, updateTask } = await import("@/lib/db/tasks");
  const task = getTask(taskId);
  if (!task) return notFound(`Task not found: ${taskId}`);
  if (task.status !== "failed") {
    return conflict(
      `Task ${taskId} has no resumable session and isn't failed; nothing to continue`,
    );
  }
  const description = `${task.description}\n\n## Follow-up\n${prompt.trim()}`;
  updateTask(taskId, { description, status: "pending", worktree_path: null });
  try {
    const result = runTaskWithCap(taskId);
    if (result.queued) {
      return ok({ queued: true, position: result.position, resumed: false });
    }
    result.done.catch(() => {});
    return ok({ runId: result.runId, resumed: false });
  } catch (err) {
    return serverError((err as Error).message);
  }
}
