"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { Project } from "@/lib/db/projects";
import type { TaskCountsByStatus } from "@/lib/db/tasks";
import { ProjectCard } from "@/components/ProjectCard";
import { AddProjectModal } from "@/components/AddProjectModal";
import { RunningTasksPanel } from "@/components/RunningTasksPanel";
import { useAutoSync } from "@/components/useAutoSync";

interface ProjectWithCounts extends Project {
  task_counts: TaskCountsByStatus;
}

export default function Dashboard() {
  const [projects, setProjects] = useState<ProjectWithCounts[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  // Launch-time sync: fire one Apple Notes round-trip when the
  // dashboard mounts. No interval — the periodic poll lives on
  // /backlog where it's more visually relevant. Errors are swallowed
  // here (no UI surface on the dashboard); the user will see them on
  // /backlog if they navigate there.
  useAutoSync();

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/projects");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load");
      setProjects(data.projects);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <>
      <RunningTasksPanel />
      <section>
        <div className="mb-4 flex items-baseline justify-between">
          <h1 className="text-xl font-semibold tracking-tight text-zinc-50">
            Projects
          </h1>
          <div className="flex items-baseline gap-3 text-xs">
            <Link
              href="/backlog"
              className="text-kraken-ice underline-offset-2 transition hover:underline"
            >
              Backlog
            </Link>
            <Link
              href="/discover"
              className="text-kraken-ice underline-offset-2 transition hover:underline"
            >
              Discover
            </Link>
            <Link
              href="/settings"
              className="text-kraken-ice underline-offset-2 transition hover:underline"
            >
              Settings
            </Link>
            <span className="text-kraken-shadow">
              {loading ? "loading…" : `${projects.length} total`}
            </span>
          </div>
        </div>

        {error ? (
          <p
            className="mb-4 rounded-md border border-kraken-alert/30 bg-kraken-alert/10 px-3 py-2 text-sm text-kraken-alert"
            role="alert"
          >
            {error}
          </p>
        ) : null}

        {loading ? null : projects.length === 0 ? (
          <div className="rounded-lg border border-dashed border-kraken-boundless p-8 text-center">
            {/* Crane motif on empty states — reinforces the drydock/port theme. */}
            <p aria-hidden="true" className="text-3xl">🏗️</p>
            <p className="mt-2 text-sm text-zinc-300">No projects in drydock yet.</p>
            <p className="mt-1 text-xs text-kraken-shadow">
              Tap “+” to add a project and start dispatching tasks.
            </p>
          </div>
        ) : (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((project) => (
              <li key={project.id}>
                <ProjectCard
                  project={project}
                  taskCounts={project.task_counts}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* FAB: keep above the iOS home indicator with safe-area inset. */}
      <button
        type="button"
        onClick={() => setModalOpen(true)}
        className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] right-4 z-10 flex h-14 w-14 items-center justify-center rounded-full bg-kraken-ice text-2xl font-light text-kraken-deep shadow-lg transition hover:brightness-110"
        aria-label="Add project"
      >
        +
      </button>

      <AddProjectModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreated={() => {
          setModalOpen(false);
          void refresh();
        }}
      />
    </>
  );
}
