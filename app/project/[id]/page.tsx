"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { use } from "react";
import type { Project } from "@/lib/db/projects";
import type { Task } from "@/lib/db/tasks";
import type { Run } from "@/lib/db/runs";
import { TaskCard } from "@/components/TaskCard";
import { AddTaskModal } from "@/components/AddTaskModal";
import { StreamViewer } from "@/components/StreamViewer";
import { ProviderBadge } from "@/components/ProviderBadge";
import { ProjectDocs } from "@/components/ProjectDocs";

// Next 15 wraps dynamic-route params in a Promise. `use()` unwraps it inside
// a client component without forcing the whole page to be async.
export default function ProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [project, setProject] = useState<Project | null>(null);
  const [tasks, setTasks] = useState<Array<Task & { latest_run: Run | null }>>(
    [],
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [streamTaskId, setStreamTaskId] = useState<string | null>(null);
  // Bumped whenever a new run is started so StreamViewer re-subscribes even
  // when the user reruns the same task.
  const [streamKey, setStreamKey] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const [projectRes, tasksRes] = await Promise.all([
        fetch(`/api/projects/${id}`),
        fetch(`/api/tasks?projectId=${encodeURIComponent(id)}`),
      ]);
      const projectData = await projectRes.json();
      const tasksData = await tasksRes.json();
      if (!projectRes.ok) {
        throw new Error(projectData.error ?? "Project not found");
      }
      if (!tasksRes.ok) {
        throw new Error(tasksData.error ?? "Failed to load tasks");
      }
      setProject(projectData.project);
      setTasks(tasksData.tasks);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll for task updates while a stream is open so badges flip from
  // running → done/failed without the user having to refresh manually.
  useEffect(() => {
    if (!streamTaskId) return;
    const t = setInterval(() => {
      void refresh();
    }, 2000);
    return () => clearInterval(t);
  }, [streamTaskId, refresh]);

  if (loading) {
    return <p className="text-sm text-zinc-400">Loading…</p>;
  }
  if (error || !project) {
    return (
      <div>
        <Link
          href="/"
          className="text-sm text-zinc-400 transition hover:text-zinc-200"
        >
          ← Back to projects
        </Link>
        <p
          className="mt-4 rounded-md border border-kraken-alert/30 bg-kraken-alert/10 px-3 py-2 text-sm text-kraken-alert"
          role="alert"
        >
          {error ?? "Project not found"}
        </p>
      </div>
    );
  }

  return (
    <>
      <Link
        href="/"
        className="text-sm text-zinc-400 transition hover:text-zinc-200"
      >
        ← Back to projects
      </Link>
      <header className="mt-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-zinc-50">
            {project.name}
          </h1>
          {project.description ? (
            <p className="mt-1 text-sm text-zinc-400">{project.description}</p>
          ) : null}
          <p className="mt-1 truncate font-mono text-xs text-zinc-500">
            {project.path}
          </p>
        </div>
        <ProviderBadge provider={project.provider} />
      </header>

      <section className="mt-6">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-zinc-400">
          Tasks
        </h2>
        {tasks.length === 0 ? (
          <div className="rounded-lg border border-dashed border-kraken-boundless p-8 text-center">
            <p aria-hidden="true" className="text-3xl">⚓</p>
            <p className="mt-2 text-sm text-zinc-300">No tasks yet.</p>
            <p className="mt-1 text-xs text-kraken-shadow">
              Tap “+” to add one and dispatch the agent.
            </p>
          </div>
        ) : (
          <ul className="space-y-3">
            {tasks.map((task) => (
              <li key={task.id}>
                <TaskCard
                  task={task}
                  latestRun={task.latest_run}
                  onRunStarted={() => {
                    setStreamTaskId(task.id);
                    setStreamKey((k) => k + 1);
                    void refresh();
                  }}
                  onDeleted={() => void refresh()}
                  onRetried={() => void refresh()}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <ProjectDocs projectId={id} />

      <button
        type="button"
        onClick={() => setModalOpen(true)}
        className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] right-4 z-10 flex h-14 w-14 items-center justify-center rounded-full bg-kraken-ice text-2xl font-light text-kraken-deep shadow-lg transition hover:brightness-110"
        aria-label="Add task"
      >
        +
      </button>

      <AddTaskModal
        open={modalOpen}
        projectId={id}
        defaultProvider={project.provider}
        onClose={() => setModalOpen(false)}
        onCreated={() => {
          setModalOpen(false);
          void refresh();
        }}
      />

      {streamTaskId ? (
        <StreamViewer
          taskId={streamTaskId}
          subscriptionKey={streamKey}
          onClose={() => setStreamTaskId(null)}
        />
      ) : null}
    </>
  );
}
