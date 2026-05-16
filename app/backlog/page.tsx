"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { SyncStatus } from "@/components/SyncStatus";
import { useAutoSync } from "@/components/useAutoSync";

type BacklogStatus = "idea" | "in_progress" | "done" | "dropped";

interface BacklogItem {
  id: string;
  title: string;
  description: string | null;
  project_id: string | null;
  status: BacklogStatus;
  priority: number;
  source: "manual" | "apple-notes";
  external_id: string | null;
  task_id: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

interface Project {
  id: string;
  name: string;
  provider: "claude" | "gemini";
}

const STATUS_LABELS: Record<BacklogStatus, string> = {
  idea: "Idea",
  in_progress: "In progress",
  done: "Done",
  dropped: "Dropped",
};

const STATUS_FILTERS: Array<BacklogStatus | "all"> = [
  "all",
  "idea",
  "in_progress",
  "done",
];

export default function BacklogPage() {
  const [items, setItems] = useState<BacklogItem[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [filter, setFilter] = useState<BacklogStatus | "all">("idea");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [newProjectId, setNewProjectId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  // Inline-edit state. One row at a time — clicking Edit on a second
  // row would discard the unsaved buffer of the first, but the layout
  // keeps both Save and Cancel within easy thumb reach so that's fine.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");

  // Auto-sync orchestrator: one sync on mount, then every 30s while
  // the tab is visible. Lets the user add an item directly to the
  // Apple Note (from their phone or the Notes app) and see it appear
  // in DryDock without manually clicking anything.
  const {
    syncing,
    lastSyncedAt,
    error: syncError,
    triggerSync,
  } = useAutoSync({ intervalMs: 30_000 });

  const refresh = useCallback(async () => {
    try {
      const [itemsRes, projectsRes] = await Promise.all([
        fetch(
          filter === "all"
            ? "/api/backlog"
            : `/api/backlog?status=${filter}`,
        ),
        fetch("/api/projects"),
      ]);
      const itemsData = await itemsRes.json();
      const projectsData = await projectsRes.json();
      if (!itemsRes.ok) throw new Error(itemsData.error ?? "Failed to load");
      setItems(itemsData.items);
      setProjects(projectsData.projects ?? []);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // After every successful sync, re-fetch the items list so any new
  // rows pulled from Apple Notes show up without a manual reload.
  // Guarded on lastSyncedAt so initial renders (when it's still null)
  // don't fire a redundant fetch right after the mount-time refresh.
  useEffect(() => {
    if (lastSyncedAt !== null) void refresh();
  }, [lastSyncedAt, refresh]);

  const projectName = (projectId: string | null): string => {
    if (!projectId) return "Unassigned";
    return projects.find((p) => p.id === projectId)?.name ?? "(deleted)";
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim()) return;
    setBusy(true);
    try {
      const res = await fetch("/api/backlog", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: newTitle.trim(),
          project_id: newProjectId || null,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "Create failed");
        return;
      }
      setNewTitle("");
      void refresh();
    } finally {
      setBusy(false);
    }
  };

  const handleStatus = async (item: BacklogItem, status: BacklogStatus) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/backlog/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "Update failed");
        return;
      }
      void refresh();
    } finally {
      setBusy(false);
    }
  };

  const handleAssign = async (item: BacklogItem, projectId: string) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/backlog/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: projectId || null }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "Assign failed");
        return;
      }
      void refresh();
    } finally {
      setBusy(false);
    }
  };

  const handleBurn = async (item: BacklogItem) => {
    if (!item.project_id) {
      setError("Assign a project before burning down this item.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/backlog/${item.id}/burn`, {
        method: "POST",
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "Burn-down failed");
        return;
      }
      // Navigate to the project so the user can hit Run on the new task.
      window.location.href = `/project/${item.project_id}`;
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (item: BacklogItem) => {
    if (!confirm(`Delete "${item.title}"?`)) return;
    setBusy(true);
    try {
      await fetch(`/api/backlog/${item.id}`, { method: "DELETE" });
      void refresh();
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (item: BacklogItem) => {
    setEditingId(item.id);
    setEditTitle(item.title);
    setEditDescription(item.description ?? "");
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditTitle("");
    setEditDescription("");
  };

  const saveEdit = async (item: BacklogItem) => {
    const nextTitle = editTitle.trim();
    if (!nextTitle) {
      setError("Title can't be empty.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/backlog/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: nextTitle,
          // Empty input → null so the description row disappears
          // from the card rather than rendering an empty <p>.
          description: editDescription.trim() === "" ? null : editDescription,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error ?? "Save failed");
        return;
      }
      cancelEdit();
      void refresh();
    } finally {
      setBusy(false);
    }
  };

  const handleSync = async (): Promise<void> => {
    // Defer to the auto-sync hook so its in-flight state, error, and
    // lastSyncedAt all flow through SyncStatus. The hook's own poll
    // is paused-as-shared via the server-side mutex — a click while a
    // poll is mid-flight just awaits the same promise.
    await triggerSync();
  };

  return (
    <>
      <Link
        href="/"
        className="text-sm text-zinc-400 transition hover:text-zinc-200"
      >
        ← Back to projects
      </Link>
      <header className="mt-3 mb-4 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-zinc-50">
            Backlog
          </h1>
          <p className="mt-1 text-sm text-kraken-shadow">
            Cross-project ideas. Assign one to a project, then burn down to
            dispatch as a task. Syncs with the &ldquo;DryDock Backlog&rdquo;
            Apple Note.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <button
            type="button"
            onClick={() => void handleSync()}
            disabled={busy || syncing}
            className="inline-flex min-h-[44px] items-center rounded-md border border-kraken-boundless px-3 text-sm text-zinc-200 transition hover:bg-kraken-boundless/30 disabled:opacity-50"
          >
            ↻ Sync Notes
          </button>
          <SyncStatus
            syncing={syncing}
            lastSyncedAt={lastSyncedAt}
            error={syncError}
          />
        </div>
      </header>

      {error ? (
        <p
          className="mb-4 rounded-md border border-kraken-alert/30 bg-kraken-alert/10 px-3 py-2 text-sm text-kraken-alert"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      <form
        onSubmit={handleCreate}
        className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-stretch"
      >
        <input
          type="text"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          aria-label="New idea"
          placeholder="A new idea, captured anywhere…"
          className="flex-1 min-h-[44px] rounded-md border border-kraken-boundless bg-kraken-deep px-3 text-zinc-50 placeholder-zinc-600 focus:border-kraken-ice focus:outline-none"
        />
        <select
          value={newProjectId}
          onChange={(e) => setNewProjectId(e.target.value)}
          aria-label="Assign to project"
          className="min-h-[44px] rounded-md border border-kraken-boundless bg-kraken-deep px-3 text-zinc-50 focus:border-kraken-ice focus:outline-none"
        >
          <option value="">Unassigned</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button
          type="submit"
          disabled={busy || newTitle.trim() === ""}
          className="min-h-[44px] rounded-md bg-kraken-ice px-4 text-sm font-semibold text-kraken-deep transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Add
        </button>
      </form>

      <div className="mb-3 flex flex-wrap gap-2">
        {STATUS_FILTERS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setFilter(s)}
            className={`min-h-[36px] rounded-full px-3 text-xs font-medium transition ${
              filter === s
                ? "bg-kraken-ice text-kraken-deep"
                : "border border-kraken-boundless text-zinc-300 hover:bg-kraken-boundless/30"
            }`}
          >
            {s === "all" ? "All" : STATUS_LABELS[s]}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-sm text-kraken-shadow">Loading…</p>
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-kraken-boundless p-8 text-center">
          <p aria-hidden="true" className="text-3xl">⚓</p>
          <p className="mt-2 text-sm text-zinc-300">
            No {filter === "all" ? "" : STATUS_LABELS[filter].toLowerCase()}{" "}
            backlog items.
          </p>
          <p className="mt-1 text-xs text-kraken-shadow">
            Add one above, or hit Sync Notes to pull from Apple Notes.
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {items.map((item) => (
            <li
              key={item.id}
              className="rounded-lg border border-kraken-boundless bg-kraken-surface p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  {editingId === item.id ? (
                    <div className="flex flex-col gap-2">
                      <input
                        type="text"
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        aria-label="Edit title"
                        className="min-h-[44px] rounded-md border border-kraken-ice/40 bg-kraken-deep px-3 text-base font-semibold text-zinc-50 focus:border-kraken-ice focus:outline-none"
                        autoFocus
                      />
                      <textarea
                        value={editDescription}
                        onChange={(e) => setEditDescription(e.target.value)}
                        aria-label="Edit description"
                        placeholder="Description (optional)"
                        rows={2}
                        className="rounded-md border border-kraken-boundless bg-kraken-deep px-3 py-2 text-sm text-zinc-300 placeholder-zinc-600 focus:border-kraken-ice focus:outline-none"
                      />
                    </div>
                  ) : (
                    <>
                      <h3 className="text-base font-semibold text-zinc-50">
                        {item.title}
                      </h3>
                      {item.description ? (
                        <p className="mt-1 text-sm text-zinc-400">
                          {item.description}
                        </p>
                      ) : null}
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-kraken-shadow">
                        <span className="rounded-full bg-kraken-boundless/40 px-2 py-0.5 text-zinc-300">
                          {STATUS_LABELS[item.status]}
                        </span>
                        <span>
                          {item.project_id
                            ? projectName(item.project_id)
                            : "Unassigned"}
                        </span>
                        {item.source === "apple-notes" ? (
                          <span className="rounded-full border border-yellow-500/40 px-2 py-0.5 text-yellow-300">
                            from Notes
                          </span>
                        ) : null}
                        {item.task_id ? (
                          <Link
                            href={`/project/${item.project_id}`}
                            className="text-kraken-ice underline-offset-2 hover:underline"
                          >
                            task ↗
                          </Link>
                        ) : null}
                      </div>
                    </>
                  )}
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                {editingId === item.id ? (
                  <>
                    <button
                      type="button"
                      onClick={() => void saveEdit(item)}
                      disabled={busy || editTitle.trim() === ""}
                      className="min-h-[36px] rounded-md bg-kraken-ice px-3 text-xs font-semibold text-kraken-deep transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={cancelEdit}
                      disabled={busy}
                      className="min-h-[36px] rounded-md border border-kraken-boundless px-3 text-xs text-zinc-300 transition hover:bg-kraken-boundless/30"
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <select
                      value={item.project_id ?? ""}
                      onChange={(e) => handleAssign(item, e.target.value)}
                      disabled={busy}
                      className="min-h-[36px] rounded-md border border-kraken-boundless bg-kraken-deep px-2 text-xs text-zinc-50 focus:border-kraken-ice focus:outline-none"
                      aria-label="Assign project"
                    >
                      <option value="">Unassigned</option>
                      {projects.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                    {item.status === "idea" ? (
                      <button
                        type="button"
                        onClick={() => handleBurn(item)}
                        disabled={busy || !item.project_id}
                        title={
                          item.project_id
                            ? "Create a task in the assigned project"
                            : "Assign a project first"
                        }
                        className="min-h-[36px] rounded-md bg-kraken-ice px-3 text-xs font-semibold text-kraken-deep transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        🔥 Burn down
                      </button>
                    ) : null}
                    {item.status !== "done" ? (
                      <button
                        type="button"
                        onClick={() => handleStatus(item, "done")}
                        disabled={busy}
                        className="min-h-[36px] rounded-md border border-emerald-500/40 px-3 text-xs text-emerald-300 transition hover:bg-emerald-500/10"
                      >
                        Mark done
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => startEdit(item)}
                      disabled={busy}
                      className="min-h-[36px] rounded-md border border-kraken-boundless px-3 text-xs text-zinc-300 transition hover:bg-kraken-boundless/30"
                      aria-label="Edit item"
                    >
                      ✏️ Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(item)}
                      disabled={busy}
                      className="ml-auto min-h-[36px] rounded-md px-2 text-base text-zinc-500 transition hover:text-kraken-alert"
                      aria-label="Delete item"
                      title="Delete this item permanently."
                    >
                      🗑️
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
