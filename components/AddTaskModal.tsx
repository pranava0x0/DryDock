"use client";

import { useState } from "react";
import type { ProviderName } from "@/lib/providers";

export interface AddTaskModalProps {
  open: boolean;
  projectId: string;
  defaultProvider: ProviderName;
  onClose: () => void;
  onCreated: () => void;
}

export function AddTaskModal({
  open,
  projectId,
  defaultProvider,
  onClose,
  onCreated,
}: AddTaskModalProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [provider, setProvider] = useState<ProviderName>(defaultProvider);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const reset = () => {
    setTitle("");
    setDescription("");
    setProvider(defaultProvider);
    setBusy(false);
    setError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          title: title.trim(),
          description: description.trim(),
          provider,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to create task");
        return;
      }
      reset();
      onCreated();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-20 flex items-end justify-center bg-black/60 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label="Add task"
      onClick={() => {
        if (!busy) {
          reset();
          onClose();
        }
      }}
    >
      <div
        className="w-full max-w-md rounded-t-2xl border border-kraken-boundless bg-kraken-surface p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-zinc-50">Add task</h2>
        <form onSubmit={handleSubmit} className="mt-4 space-y-3">
          <label className="block text-sm">
            <span className="text-zinc-300">Title</span>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              className="mt-1 block w-full min-h-[44px] rounded-md border border-kraken-boundless bg-kraken-deep px-3 text-zinc-50 placeholder-zinc-600 focus:border-kraken-ice focus:outline-none"
              placeholder="Add dark-mode toggle to settings"
            />
          </label>
          <label className="block text-sm">
            <span className="text-zinc-300">Description</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              required
              rows={4}
              className="mt-1 block w-full rounded-md border border-kraken-boundless bg-kraken-deep p-3 text-zinc-50 placeholder-zinc-600 focus:border-kraken-ice focus:outline-none"
              placeholder="What should the agent do? Be specific — this is the prompt the CLI receives."
            />
          </label>
          <fieldset className="block text-sm">
            <legend className="text-zinc-300">Provider</legend>
            <div className="mt-1 flex gap-2">
              {(["claude", "gemini"] as ProviderName[]).map((p) => {
                const selected = provider === p;
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setProvider(p)}
                    className={`flex-1 min-h-[44px] rounded-md border px-3 text-sm font-medium transition ${
                      selected
                        ? "border-kraken-ice bg-kraken-ice/10 text-kraken-ice"
                        : "border-kraken-boundless bg-kraken-deep text-zinc-300 hover:border-kraken-shadow"
                    }`}
                  >
                    {p === "claude" ? "Claude" : "Gemini"}
                  </button>
                );
              })}
            </div>
          </fieldset>
          {error ? (
            <p className="text-xs text-red-300" role="alert">
              {error}
            </p>
          ) : null}
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={() => {
                if (!busy) {
                  reset();
                  onClose();
                }
              }}
              className="flex-1 min-h-[44px] rounded-md border border-kraken-boundless px-3 text-sm font-medium text-zinc-200 transition hover:bg-kraken-boundless/30"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="flex-1 min-h-[44px] rounded-md bg-kraken-ice px-3 text-sm font-semibold text-kraken-deep transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "Creating…" : "Create"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
