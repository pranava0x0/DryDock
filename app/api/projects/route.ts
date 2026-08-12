import type { NextRequest } from "next/server";
import { createProject, listProjects } from "@/lib/db/projects";
import { taskCountsByProject } from "@/lib/db/tasks";
import { isProviderName } from "@/lib/providers";
import { isAutonomyLevel, type AutonomyLevel } from "@/lib/providers/types";
import { lastCommitForPaths } from "@/lib/projects/last-commit";
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

    // "Last worked on" comes from git, not from DryDock's own tables: a
    // project you've been committing to all week can still have zero tasks
    // here, and sorting by task activity would have put 30 identical
    // zero-activity projects in an arbitrary order.
    const commits = await lastCommitForPaths(withCounts.map((p) => p.path));
    const decorated = withCounts.map((project) => ({
      ...project,
      last_commit_at: commits.get(project.path) ?? null,
    }));

    decorated.sort((a, b) => {
      // Un-versioned projects have no commit time at all; they sort last
      // rather than pretending to be ancient or brand new.
      if (a.last_commit_at === null && b.last_commit_at === null) {
        return a.name.localeCompare(b.name);
      }
      if (a.last_commit_at === null) return 1;
      if (b.last_commit_at === null) return -1;
      return b.last_commit_at - a.last_commit_at;
    });

    return ok({ projects: decorated });
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

  let autonomy: AutonomyLevel = "edits";
  if (raw.autonomy !== undefined) {
    if (!isAutonomyLevel(raw.autonomy)) {
      return badRequest("`autonomy` must be 'readonly', 'edits', or 'full'");
    }
    autonomy = raw.autonomy;
  }

  try {
    const project = createProject({
      name,
      path,
      description,
      provider,
      test_command,
      autonomy,
    });
    return created({ project });
  } catch (err) {
    return serverError((err as Error).message);
  }
}
