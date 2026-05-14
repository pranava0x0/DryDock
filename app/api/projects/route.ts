import type { NextRequest } from "next/server";
import { createProject, listProjects } from "@/lib/db/projects";
import { taskCountsByProject } from "@/lib/db/tasks";
import { isProviderName } from "@/lib/providers";
import { badRequest, created, ok, serverError } from "@/lib/api/json";

// Force the Node runtime: the DB layer uses better-sqlite3 (native bindings)
// which won't work on the Edge runtime. We also stream events from
// long-running subprocesses elsewhere; the Node runtime is the only safe
// choice for the whole `/api` tree.
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  try {
    const projects = listProjects();
    // Decorate each project with its task counts so the dashboard can render
    // "3 pending / 1 running" without a per-card follow-up fetch.
    const withCounts = projects.map((project) => ({
      ...project,
      task_counts: taskCountsByProject(project.id),
    }));
    return ok({ projects: withCounts });
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

  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const path = typeof raw.path === "string" ? raw.path.trim() : "";
  if (!name) return badRequest("`name` is required");
  if (!path) return badRequest("`path` is required");

  const description =
    typeof raw.description === "string" ? raw.description : null;

  let provider: "claude" | "gemini" = "claude";
  if (raw.provider !== undefined) {
    if (!isProviderName(raw.provider)) {
      return badRequest("`provider` must be 'claude' or 'gemini'");
    }
    provider = raw.provider;
  }

  let test_command: string | null = null;
  if (raw.test_command !== undefined && raw.test_command !== null) {
    if (typeof raw.test_command !== "string") {
      return badRequest("`test_command` must be a string or null");
    }
    const trimmed = raw.test_command.trim();
    test_command = trimmed.length > 0 ? trimmed : null;
  }

  try {
    const project = createProject({
      name,
      path,
      description,
      provider,
      test_command,
    });
    return created({ project });
  } catch (err) {
    return serverError((err as Error).message);
  }
}
