import type { NextRequest } from "next/server";
import { existsSync, statSync } from "node:fs";
import { createTask } from "@/lib/db/tasks";
import { getProject } from "@/lib/db/projects";
import {
  isAutonomyLevel,
  isProviderName,
  AUTONOMY_LEVELS,
  type AutonomyLevel,
} from "@/lib/providers/types";
import { CLAUDE_MODELS } from "@/lib/routing/rules";
import { runTaskWithCap, DispatchError } from "@/lib/orchestrator/dispatch";
import {
  SESSION_PROMPT_MAX_CHARS,
  synthesizeSessionTitle,
} from "@/lib/orchestrator/prompt";
import {
  accepted,
  badRequest,
  conflict,
  created,
  notFound,
  serverError,
  tooManyRequests,
} from "@/lib/api/json";
import { takeSessionKickoffToken } from "@/lib/api/rate-limit";
import { rejectRemoteDispatch } from "@/lib/api/local-only";

export const runtime = "nodejs";

/**
 * One-call session kickoff: a free-form prompt against a chosen project
 * becomes a task (title synthesized from the prompt's first line) that is
 * immediately dispatched — or queued when the concurrency cap is full.
 *
 * This is the highest-consequence write in the app (it spawns an agent
 * subprocess on the host), so it layers checks the two-step
 * create-then-run flow spreads across routes: the optional local-only
 * kill-switch, an in-process rate limit, and a preflight that the
 * project's path actually exists on disk (DD-017 left stale rows whose
 * dispatch would otherwise die in a cryptic worktree/spawn ENOENT).
 *
 * Everything downstream is the existing pipeline — createTask +
 * runTaskWithCap — so the cap, queue, stream, follow-ups, cancel, and
 * retry all work on a session exactly as they do on a hand-made task.
 */
export async function POST(request: NextRequest): Promise<Response> {
  const localOnly = rejectRemoteDispatch(request);
  if (localOnly) return localOnly;

  // Rate limit before body parse: the cheapest shield goes first, and the
  // middleware has already authenticated the caller.
  const token = takeSessionKickoffToken();
  if (!token.ok) {
    return tooManyRequests(
      "Too many session kickoffs — wait a moment and try again",
      token.retryAfterSec,
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("Request body must be valid JSON");
  }
  if (typeof body !== "object" || body === null) {
    return badRequest("Request body must be an object");
  }
  const raw = body as Record<string, unknown>;

  const projectId = typeof raw.projectId === "string" ? raw.projectId : "";
  if (!projectId) return badRequest("`projectId` is required");
  const project = getProject(projectId);
  if (!project) return notFound(`Project not found: ${projectId}`);

  const prompt = typeof raw.prompt === "string" ? raw.prompt.trim() : "";
  if (!prompt) return badRequest("`prompt` is required");
  if (prompt.length > SESSION_PROMPT_MAX_CHARS) {
    return badRequest(
      `\`prompt\` is too long (${prompt.length} chars; max ${SESSION_PROMPT_MAX_CHARS})`,
    );
  }

  let provider = project.provider;
  if (raw.provider !== undefined) {
    if (!isProviderName(raw.provider)) {
      return badRequest("`provider` must be 'claude' or 'gemini'");
    }
    provider = raw.provider;
  }

  let model: string | null = null;
  if (raw.model !== undefined && raw.model !== null && raw.model !== "") {
    if (
      typeof raw.model !== "string" ||
      !CLAUDE_MODELS.some((m) => m.value === raw.model)
    ) {
      return badRequest(
        `\`model\` must be one of: ${CLAUDE_MODELS.map((m) => m.value).join(", ")}`,
      );
    }
    if (provider !== "claude") {
      // Refuse rather than silently ignore — a model override on a
      // provider that drops it would be a confident-looking no-op.
      return badRequest("`model` is only supported for the claude provider");
    }
    model = raw.model;
  }

  let autonomy: AutonomyLevel | null = null;
  if (raw.autonomy !== undefined && raw.autonomy !== null && raw.autonomy !== "") {
    if (!isAutonomyLevel(raw.autonomy)) {
      return badRequest(
        `\`autonomy\` must be one of: ${AUTONOMY_LEVELS.join(", ")}`,
      );
    }
    autonomy = raw.autonomy;
  }

  // DD-017 preflight: stale project rows point at directories that no
  // longer exist. Fail with the path in hand instead of letting the
  // worktree/spawn layer surface a bare ENOENT mid-run.
  if (!existsSync(project.path) || !statSync(project.path).isDirectory()) {
    return conflict(
      `Project path is not a directory on disk: ${project.path} — fix the ` +
        `project's path (or re-import it from /discover) before dispatching`,
    );
  }

  try {
    const task = createTask({
      project_id: project.id,
      title: synthesizeSessionTitle(prompt),
      description: prompt,
      provider,
      model,
      autonomy,
      source: "session",
    });
    const result = runTaskWithCap(task.id);
    if (result.queued) {
      return accepted({ taskId: task.id, queued: true, position: result.position });
    }
    result.done.catch(() => {});
    return created({ taskId: task.id, runId: result.runId });
  } catch (err) {
    if (err instanceof DispatchError) {
      // Shouldn't happen for a task created in this request, but map the
      // codes the same way /run does rather than 500ing.
      if (err.code === "task_not_found" || err.code === "project_not_found") {
        return notFound(err.message);
      }
      if (err.code === "already_claimed") {
        return conflict(err.message);
      }
    }
    return serverError((err as Error).message);
  }
}
