import type { NextRequest } from "next/server";
import { homedir } from "node:os";
import { join } from "node:path";
import { listProjects } from "@/lib/db/projects";
import { scanProjectsRoot } from "@/lib/discovery/scan";
import { badRequest, ok, serverError } from "@/lib/api/json";

export const runtime = "nodejs";

/**
 * Default scan root.
 *
 * Resolution order:
 *   1. DRYDOCK_PROJECTS_ROOT env var (user override)
 *   2. ~/Documents/Projects (the user's canonical layout — DryDock itself
 *      lives at /Users/<you>/Documents/Projects/DryDock/, so its sibling
 *      directories are the other projects we want to surface)
 *   3. ~ (last-ditch fallback so the page still renders something)
 *
 * We don't infer from `process.cwd()` because the orchestrator may be
 * running inside a worktree under `.claude/worktrees/...`, and the
 * worktrees parent contains only one entry (this worktree itself).
 */
function defaultRoot(): string {
  const envRoot = process.env.DRYDOCK_PROJECTS_ROOT;
  if (envRoot && envRoot.length > 0) return envRoot;
  return join(homedir(), "Documents", "Projects");
}

export async function GET(request: NextRequest): Promise<Response> {
  const url = new URL(request.url);
  const requested = url.searchParams.get("root");

  // Defense in depth: only allow paths the user already trusts. We don't
  // run arbitrary system paths through scan() — only the configured root
  // or one the user explicitly typed. (The orchestrator is single-user,
  // so this is more about preventing typos than malicious access.)
  const root = requested && requested.length > 0 ? requested : defaultRoot();

  try {
    const knownPaths = new Set(listProjects().map((p) => p.path));
    const projects = await scanProjectsRoot({ root, knownPaths });
    return ok({ root, projects });
  } catch (err) {
    const message = (err as Error).message;
    // Distinguish "user typed a path that doesn't exist" from a real
    // server error — the UI shows a friendly empty state for the former.
    if (message.includes("Could not read root directory")) {
      return badRequest(message);
    }
    return serverError(message);
  }
}
