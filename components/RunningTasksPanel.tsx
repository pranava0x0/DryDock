"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ProviderBadge } from "@/components/ProviderBadge";
import { StatusBadge } from "@/components/StatusBadge";

interface RunningTask {
  id: string;
  project_id: string;
  project_name: string;
  title: string;
  provider: "claude" | "gemini";
  status: "claimed" | "running";
  branch: string | null;
  claimed_at: number | null;
  updated_at: number;
  latest_run: {
    cost_usd: number | null;
    started_at: number;
  } | null;
}

/**
 * Polling cadence. 3s is brisk enough that a stuck task is obvious within
 * a few seconds without hammering the SQLite-backed API. We bump it to 8s
 * when the tab is hidden to avoid wasted work in the background.
 */
const POLL_INTERVAL_MS = 3000;
const POLL_INTERVAL_HIDDEN_MS = 8000;

function formatElapsed(startSec: number, nowMs: number): string {
  const sec = Math.max(0, Math.floor(nowMs / 1000 - startSec));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

export function RunningTasksPanel() {
  const [tasks, setTasks] = useState<RunningTask[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Re-render every second so the elapsed-time column updates between polls.
  const [now, setNow] = useState(Date.now());

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/tasks/running");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load");
      setTasks(data.tasks);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    let interval: ReturnType<typeof setInterval>;
    const start = () => {
      const cadence = document.hidden
        ? POLL_INTERVAL_HIDDEN_MS
        : POLL_INTERVAL_MS;
      interval = setInterval(() => void refresh(), cadence);
    };
    const restart = () => {
      clearInterval(interval);
      start();
      void refresh();
    };
    start();
    document.addEventListener("visibilitychange", restart);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", restart);
    };
  }, [refresh]);

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  // Collapse the panel entirely on the empty state so the dashboard's
  // primary content (projects grid) doesn't get pushed down for nothing.
  if (!tasks || tasks.length === 0) {
    return error ? (
      <p
        className="mb-4 rounded-md border border-kraken-alert/30 bg-kraken-alert/10 px-3 py-2 text-xs text-kraken-alert"
        role="alert"
      >
        Live tasks: {error}
      </p>
    ) : null;
  }

  return (
    <section
      aria-labelledby="running-tasks-heading"
      className="mb-6 rounded-lg border border-kraken-ice/30 bg-kraken-deep/60 p-3"
    >
      <div className="mb-2 flex items-baseline justify-between">
        <h2
          id="running-tasks-heading"
          className="flex items-center gap-2 text-sm font-semibold text-zinc-100"
        >
          <span
            aria-hidden="true"
            className="inline-block h-2 w-2 animate-pulse rounded-full bg-kraken-ice"
          />
          Running now
        </h2>
        <span className="text-xs text-kraken-shadow">
          {tasks.length} in flight
        </span>
      </div>
      <ul className="divide-y divide-kraken-boundless/40">
        {tasks.map((task) => {
          const elapsedFrom = task.latest_run?.started_at ?? task.claimed_at;
          const elapsed = elapsedFrom
            ? formatElapsed(elapsedFrom, now)
            : null;
          return (
            <li key={task.id} className="py-2">
              <Link
                href={`/project/${task.project_id}`}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm hover:bg-kraken-boundless/20 -mx-2 px-2 py-1 rounded transition min-h-[44px]"
              >
                <span className="font-medium text-zinc-100">{task.title}</span>
                <span className="text-xs text-kraken-shadow">
                  {task.project_name}
                </span>
                <span className="ml-auto flex items-center gap-2 text-xs">
                  {elapsed ? (
                    <span className="font-mono text-kraken-ice">{elapsed}</span>
                  ) : null}
                  <ProviderBadge provider={task.provider} />
                  <StatusBadge status={task.status} />
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
