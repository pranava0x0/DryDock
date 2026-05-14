import { listInFlightTasks } from "@/lib/db/tasks";
import { getProject } from "@/lib/db/projects";
import { getLatestRunForTask } from "@/lib/db/runs";
import { ok, serverError } from "@/lib/api/json";

export const runtime = "nodejs";

/**
 * Cross-project list of tasks currently in flight (claimed or running).
 * Used by the dashboard's live-tail panel so the user can spot a stuck
 * task without drilling into individual projects.
 *
 * Each row is enriched with the project name and the latest run so the
 * panel can show duration, provider, and cost-so-far without making
 * follow-up requests.
 */
export async function GET(): Promise<Response> {
  try {
    const tasks = listInFlightTasks();
    const enriched = tasks.map((task) => {
      const project = getProject(task.project_id);
      return {
        id: task.id,
        project_id: task.project_id,
        project_name: project?.name ?? "(unknown project)",
        title: task.title,
        provider: task.provider,
        status: task.status,
        branch: task.branch,
        claimed_at: task.claimed_at,
        updated_at: task.updated_at,
        latest_run: getLatestRunForTask(task.id),
      };
    });
    return ok({ tasks: enriched });
  } catch (err) {
    return serverError((err as Error).message);
  }
}
