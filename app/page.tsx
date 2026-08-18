"use client";

import { useState } from "react";
import Link from "next/link";
import { useCachedResource } from "@/components/useCachedResource";
import { InlineDisclosure } from "@/components/Disclosure";
import type { Project } from "@/lib/db/projects";
import type { TaskCountsByStatus } from "@/lib/db/tasks";
import { ProjectCard } from "@/components/ProjectCard";
import { AddProjectModal } from "@/components/AddProjectModal";
import { RunningTasksPanel } from "@/components/RunningTasksPanel";
import { OpenerOverview } from "@/components/OpenerOverview";
import { useAutoSync } from "@/components/useAutoSync";

interface ProjectWithCounts extends Project {
  task_counts: TaskCountsByStatus;
}

/**
 * Projects shown before the list is collapsed. Enough to cover "the things I
 * am actually working on" given the list is sorted by last commit; the rest
 * are one tap away.
 */
const VISIBLE_PROJECTS = 6;

export default function Dashboard() {
  const [modalOpen, setModalOpen] = useState(false);
  const [showAllProjects, setShowAllProjects] = useState(false);

  // Launch-time sync: fire one Apple Notes round-trip when the
  // dashboard mounts. No interval — the periodic poll lives on
  // /backlog where it's more visually relevant. Errors are swallowed
  // here (no UI surface on the dashboard); the user will see them on
  // /backlog if they navigate there.
  useAutoSync();

  // Cached across navigation: coming back from Analytics repaints the
  // project grid from the last payload instead of blanking to "loading…"
  // and re-fetching 30 rows.
  const {
    data,
    error,
    loading,
    refresh,
  } = useCachedResource<{ projects: ProjectWithCounts[] }>("/api/projects");
  const projects = data?.projects ?? [];

  return (
    <>
      <RunningTasksPanel />

      {/* The opener leads with activity and open work. The project list is
          still here, below, but it is reference material — not the first
          thing you have to read. */}
      <OpenerOverview />

      <section>
        <div className="mb-1 flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold tracking-tight text-zinc-50">
            Projects
          </h2>
          <div className="flex items-center gap-3">
            <span className="text-sm text-kraken-shadow">
              {loading ? "loading…" : `${projects.length} total`}
            </span>
            <Link
              href="/session/new"
              className="flex min-h-[44px] items-center rounded-md bg-kraken-ice px-4 text-sm font-semibold text-kraken-deep transition hover:brightness-110"
            >
              New session
            </Link>
          </div>
        </div>
        {/* Legend for the per-card task counts, demoted to an inline
            disclosure. Cards now render those counts only when a project
            has dispatch history (1 of 30 here), so a permanently-visible
            paragraph explaining three words that appear on one card was
            spending four lines above the fold to define vocabulary most
            readers never encounter. It stays available for when they do. */}
        <InlineDisclosure label="What the numbers on a card mean">
          <p>
            A card counts its tasks — <span className="text-zinc-300">pending</span>{" "}
            waiting to be dispatched,{" "}
            <span className="text-amber-300">active</span> with an agent running
            now, <span className="text-emerald-300">done</span> finished and
            gate-passed. A project with no tasks yet shows no counts. Sorted by
            most recently worked on.
          </p>
        </InlineDisclosure>
        <div className="mb-4" />

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
          <>
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {(showAllProjects
                ? projects
                : projects.slice(0, VISIBLE_PROJECTS)
              ).map((project) => (
                <li key={project.id}>
                  <ProjectCard
                    project={project}
                    taskCounts={project.task_counts}
                  />
                </li>
              ))}
            </ul>
            {projects.length > VISIBLE_PROJECTS ? (
              <button
                type="button"
                onClick={() => setShowAllProjects((prev) => !prev)}
                className="tap mt-3 w-full rounded-md border border-kraken-boundless px-3 text-sm text-kraken-ice transition hover:bg-kraken-boundless/30"
              >
                {showAllProjects
                  ? "Show fewer"
                  : `Show all ${projects.length} projects`}
              </button>
            ) : null}
          </>
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
