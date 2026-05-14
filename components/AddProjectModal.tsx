"use client";

import { useState } from "react";
import type { ProviderName } from "@/lib/providers";

export interface AddProjectModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

export function AddProjectModal({
  open,
  onClose,
  onCreated,
}: AddProjectModalProps) {
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [description, setDescription] = useState("");
  const [provider, setProvider] = useState<ProviderName>("claude");
  const [testCommand, setTestCommand] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const reset = () => {
    setName("");
    setPath("");
    setDescription("");
    setProvider("claude");
    setTestCommand("");
    setError(null);
    setBusy(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          path: path.trim(),
          description: description.trim() || null,
          provider,
          test_command: testCommand.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to create project");
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
      aria-label="Add project"
      // Click outside the sheet to dismiss. The sheet itself stops propagation
      // so clicks inside don't close it.
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
        <h2 className="text-lg font-semibold text-zinc-50">Add project</h2>
        <p className="mt-1 text-sm text-zinc-400">
          DryDock will run agents in the directory you specify.
        </p>
        <form onSubmit={handleSubmit} className="mt-4 space-y-3">
          <label className="block text-sm">
            <span className="text-zinc-300">Name</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              className="mt-1 block w-full min-h-[44px] rounded-md border border-kraken-boundless bg-kraken-deep px-3 text-zinc-50 placeholder-zinc-600 focus:border-kraken-ice focus:outline-none"
              placeholder="DC Elections Tracker"
            />
          </label>
          <label className="block text-sm">
            <span className="text-zinc-300">Local path</span>
            <input
              type="text"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              required
              className="mt-1 block w-full min-h-[44px] rounded-md border border-kraken-boundless bg-kraken-deep px-3 font-mono text-zinc-50 placeholder-zinc-600 focus:border-kraken-ice focus:outline-none"
              placeholder="/Users/you/Projects/your-project"
            />
          </label>
          <label className="block text-sm">
            <span className="text-zinc-300">Description (optional)</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="mt-1 block w-full rounded-md border border-kraken-boundless bg-kraken-deep p-3 text-zinc-50 placeholder-zinc-600 focus:border-kraken-ice focus:outline-none"
              placeholder="One line about this project"
            />
          </label>
          <label className="block text-sm">
            <span className="text-zinc-300">Quality gate (optional)</span>
            <input
              type="text"
              value={testCommand}
              onChange={(e) => setTestCommand(e.target.value)}
              className="mt-1 block w-full min-h-[44px] rounded-md border border-kraken-boundless bg-kraken-deep px-3 font-mono text-zinc-50 placeholder-zinc-600 focus:border-kraken-ice focus:outline-none"
              placeholder="npm test"
            />
            <span className="mt-1 block text-xs text-zinc-500">
              Runs in the task&apos;s worktree after the agent exits 0. A
              non-zero exit demotes the task to failed.
            </span>
          </label>
          <fieldset className="block text-sm">
            <legend className="text-zinc-300">Default provider</legend>
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
