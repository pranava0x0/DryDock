import Link from "next/link";
import type { Project } from "@/lib/db/projects";
import type { TaskCountsByStatus } from "@/lib/db/tasks";
import { ProviderBadge } from "./ProviderBadge";

export interface ProjectCardProps {
  project: Project;
  taskCounts: TaskCountsByStatus;
}

export function ProjectCard({ project, taskCounts }: ProjectCardProps) {
  const activeCount = taskCounts.running + taskCounts.claimed;
  /**
   * Whether this project has any dispatch history at all.
   *
   * Measured 2026-08-13: 1 of 30 projects. So the counts row was rendering
   * `0 pending · 0 active · 0 done` on essentially every card — eighteen
   * zeros across the six cards the dashboard shows, plus a paragraph above
   * explaining what the zeros mean. That is the same "thirty rows of zeros"
   * the opener was rebuilt to kill, surviving one level down.
   *
   * A zero here is a true zero, not an unread value, so hiding it loses no
   * information: the card still links through to the project, where the
   * real (empty) task list lives. The row returns the moment there is
   * something to count — which is exactly when it starts being worth the
   * space. Same idiom as the `failed > 0` line below, applied to the group.
   */
  const hasTaskActivity =
    taskCounts.pending + activeCount + taskCounts.done + taskCounts.failed > 0;
  return (
    <Link
      href={`/project/${project.id}`}
      // min-h-[88px] keeps the touch target well over the 44px guideline
      // even before the card's own padding is added.
      className="group block min-h-[88px] rounded-lg border border-kraken-boundless bg-kraken-surface p-4 transition hover:border-kraken-ice/40 hover:bg-kraken-surface/80"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold text-zinc-50">
            {project.name}
          </h3>
          {project.description ? (
            <p className="mt-1 line-clamp-2 text-sm text-zinc-400">
              {project.description}
            </p>
          ) : (
            <p className="mt-1 truncate text-xs font-mono text-zinc-500">
              {project.path}
            </p>
          )}
        </div>
        <ProviderBadge provider={project.provider} />
      </div>

      {hasTaskActivity ? (
      <dl className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-400">
        <div className="flex items-center gap-1">
          <dt className="sr-only">Pending</dt>
          <dd className="font-medium text-zinc-200">{taskCounts.pending}</dd>
          <span>pending</span>
        </div>
        <div className="flex items-center gap-1">
          <dt className="sr-only">Active</dt>
          <dd className="font-medium text-amber-300">{activeCount}</dd>
          <span>active</span>
        </div>
        <div className="flex items-center gap-1">
          <dt className="sr-only">Done</dt>
          <dd className="font-medium text-emerald-300">{taskCounts.done}</dd>
          <span>done</span>
        </div>
        {taskCounts.failed > 0 ? (
          <div className="flex items-center gap-1">
            <dt className="sr-only">Failed</dt>
            <dd className="font-medium text-kraken-alert">{taskCounts.failed}</dd>
            <span>failed</span>
          </div>
        ) : null}
      </dl>
      ) : null}
    </Link>
  );
}
