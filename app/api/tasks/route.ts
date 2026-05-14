import type { NextRequest } from "next/server";
import { createTask, listTasks, TASK_STATUSES, type TaskStatus } from "@/lib/db/tasks";
import { getProject } from "@/lib/db/projects";
import { getLatestRunForTask } from "@/lib/db/runs";
import { isProviderName } from "@/lib/providers";
import { badRequest, created, notFound, ok, serverError } from "@/lib/api/json";

export const runtime = "nodejs";

export async function GET(request: NextRequest): Promise<Response> {
  const url = new URL(request.url);
  const projectId = url.searchParams.get("projectId") ?? undefined;
  const statusParam = url.searchParams.get("status");
  let status: TaskStatus | undefined;
  if (statusParam) {
    if (!TASK_STATUSES.includes(statusParam as TaskStatus)) {
      return badRequest(
        `\`status\` must be one of: ${TASK_STATUSES.join(", ")}`,
      );
    }
    status = statusParam as TaskStatus;
  }
  try {
    const tasks = listTasks({ projectId, status });
    // Attach each task's latest run so the dashboard can show cost / gate
    // verdicts without a per-row follow-up request. Most tasks won't have
    // a run yet — `latest_run` is null in that case.
    const withRuns = tasks.map((task) => ({
      ...task,
      latest_run: getLatestRunForTask(task.id),
    }));
    return ok({ tasks: withRuns });
  } catch (err) {
    return serverError((err as Error).message);
  }
}

export async function POST(request: NextRequest): Promise<Response> {
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
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  const description =
    typeof raw.description === "string" ? raw.description.trim() : "";

  if (!projectId) return badRequest("`projectId` is required");
  if (!title) return badRequest("`title` is required");
  if (!description) return badRequest("`description` is required");

  // Verify the project exists before letting SQLite raise a FK constraint
  // error — we want a clean 404 instead of a 500 with a CONSTRAINT message.
  const project = getProject(projectId);
  if (!project) return notFound(`Project not found: ${projectId}`);

  let provider = project.provider;
  if (raw.provider !== undefined) {
    if (!isProviderName(raw.provider)) {
      return badRequest("`provider` must be 'claude' or 'gemini'");
    }
    provider = raw.provider;
  }

  let priority = 0;
  if (raw.priority !== undefined) {
    if (typeof raw.priority !== "number" || !Number.isFinite(raw.priority)) {
      return badRequest("`priority` must be a number");
    }
    priority = Math.trunc(raw.priority);
  }

  try {
    const task = createTask({
      project_id: projectId,
      title,
      description,
      provider,
      priority,
    });
    return created({ task });
  } catch (err) {
    return serverError((err as Error).message);
  }
}
