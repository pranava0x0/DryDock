"use client";

import { useState } from "react";
import type { Task } from "@/lib/db/tasks";
import type { Run } from "@/lib/db/runs";
import { ProviderBadge } from "./ProviderBadge";
import { StatusBadge } from "./StatusBadge";

export interface TaskCardProps {
  task: Task;
  /** Optional: most-recent run summary, used to show cost + gate verdict. */
  latestRun?: Run | null;
  onRunStarted: (runId: string) => void;
  onDeleted: () => void;
  /**
   * Called after a Retry POST succeeds — the parent should refresh so the
   * status flips back to pending and the Run button reappears.
   */
  onRetried?: () => void;
}

export function TaskCard({
  task,
  latestRun,
  onRunStarted,
  onDeleted,
  onRetried,
}: TaskCardProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleRun = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/tasks/${task.id}/run`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to start run");
        return;
      }
      onRunStarted(data.runId);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm(`Delete task "${task.title}"?`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/tasks/${task.id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to delete");
        return;
      }
      onDeleted();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleRetry = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/tasks/${task.id}/retry`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Failed to retry");
        return;
      }
      onRetried?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Only "pending" tasks can be re-launched; the others are either in-flight
  // or terminal. Hiding the button is clearer than disabling it.
  const canRun = task.status === "pending";
  const canRetry = task.status === "failed";

  return (
    <article className="rounded-lg border border-kraken-boundless bg-kraken-surface p-4">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold text-zinc-50">
            {task.title}
          </h3>
          <p className="mt-1 line-clamp-2 whitespace-pre-line text-sm text-zinc-400">
            {task.description}
          </p>
        </div>
        <div className="flex flex-shrink-0 flex-col items-end gap-1">
          <StatusBadge status={task.status} />
          <ProviderBadge provider={task.provider} />
        </div>
      </header>

      {task.branch ||
      task.pr_url ||
      latestRun?.cost_usd != null ||
      latestRun?.gate_status ? (
        <dl className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-500">
          {task.branch ? (
            <div className="flex items-center gap-1">
              <dt className="sr-only">Branch</dt>
              <dd className="font-mono text-zinc-300">{task.branch}</dd>
            </div>
          ) : null}
          {task.pr_url ? (
            <div className="flex items-center gap-1">
              <dt className="sr-only">Pull request</dt>
              <dd>
                <a
                  href={task.pr_url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-violet-300 underline-offset-2 hover:underline"
                >
                  PR ↗
                </a>
              </dd>
            </div>
          ) : null}
          {latestRun?.cost_usd != null ? (
            <div className="flex items-center gap-1">
              <dt className="sr-only">Cost</dt>
              <dd className="text-zinc-300">
                ${latestRun.cost_usd.toFixed(4)}
              </dd>
            </div>
          ) : null}
          {latestRun?.tokens_in != null && latestRun?.tokens_out != null ? (
            <div className="flex items-center gap-1">
              <dt className="sr-only">Tokens</dt>
              <dd className="text-zinc-400">
                {latestRun.tokens_in.toLocaleString()} in /{" "}
                {latestRun.tokens_out.toLocaleString()} out
              </dd>
            </div>
          ) : null}
          {latestRun?.gate_status ? (
            <div className="flex items-center gap-1">
              <dt className="sr-only">Quality gate</dt>
              <dd
                className={
                  latestRun.gate_status === "passed"
                    ? "text-emerald-300"
                    : "text-red-300"
                }
              >
                gate {latestRun.gate_status}
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      <footer className="mt-3 flex flex-wrap items-center gap-2">
        {canRun ? (
          <button
            type="button"
            onClick={handleRun}
            disabled={busy}
            className="inline-flex min-h-[44px] items-center rounded-md bg-kraken-ice px-4 text-sm font-semibold text-kraken-deep shadow-sm transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Starting…" : "Run"}
          </button>
        ) : null}
        {canRetry ? (
          <button
            type="button"
            onClick={handleRetry}
            disabled={busy}
            className="inline-flex min-h-[44px] items-center rounded-md bg-amber-500 px-4 text-sm font-medium text-zinc-950 shadow-sm transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Retrying…" : "Retry"}
          </button>
        ) : null}
        {task.status !== "pending" ? (
          <button
            type="button"
            onClick={() => onRunStarted(task.id)}
            className="inline-flex min-h-[44px] items-center rounded-md border border-kraken-boundless px-4 text-sm font-medium text-zinc-200 transition hover:bg-kraken-boundless/30"
          >
            View output
          </button>
        ) : null}
        <button
          type="button"
          onClick={handleDelete}
          disabled={busy}
          className="ml-auto inline-flex min-h-[44px] items-center rounded-md border border-kraken-boundless px-3 text-sm text-zinc-400 transition hover:border-kraken-alert/60 hover:text-kraken-alert disabled:cursor-not-allowed disabled:opacity-50"
        >
          Delete
        </button>
      </footer>

      {error ? (
        <p className="mt-2 text-xs text-red-300" role="alert">
          {error}
        </p>
      ) : null}
    </article>
  );
}
