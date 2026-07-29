"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { Project } from "@/lib/db/projects";
import type { AutonomyLevel, ProviderName } from "@/lib/providers/types";
import { CLAUDE_MODELS } from "@/lib/routing/rules";

// Same consequence copy as AutonomySelect, keyed for the 4-state select
// below ("" = inherit the project's profile, which that component can't
// express).
const AUTONOMY_HINTS: Record<AutonomyLevel, string> = {
  readonly: "plan/analyze, no writes",
  edits: "file edits + tests",
  full: "edits + any shell command",
};

/**
 * One-tap session kickoff: pick a project, type the prompt, go. POSTs
 * /api/sessions (create + dispatch in one call) and lands on the project
 * page with the stream viewer open — or with a queued badge when the
 * concurrency cap is full.
 */
export default function NewSessionPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [projectId, setProjectId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [provider, setProvider] = useState<ProviderName>("claude");
  const [model, setModel] = useState("");
  const [autonomy, setAutonomy] = useState<"" | AutonomyLevel>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Once the user picks a provider explicitly, switching projects stops
  // resetting it under them.
  const providerTouched = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/projects");
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Failed to load projects");
        if (cancelled) return;
        const list: Project[] = data.projects ?? [];
        setProjects(list);
        // Deep-linkable: /session/new?project=<id> preselects (used by
        // future per-project entry points); otherwise first project.
        const wanted = new URLSearchParams(window.location.search).get(
          "project",
        );
        const initial = list.find((p) => p.id === wanted) ?? list[0];
        if (initial) {
          setProjectId(initial.id);
          setProvider(initial.provider);
        }
      } catch (err) {
        if (!cancelled) setLoadError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedProject = projects.find((p) => p.id === projectId);
  const effectiveAutonomy: AutonomyLevel =
    autonomy || selectedProject?.autonomy || "edits";

  const handleProjectChange = (id: string) => {
    setProjectId(id);
    const next = projects.find((p) => p.id === id);
    if (next && !providerTouched.current) {
      setProvider(next.provider);
      if (next.provider !== "claude") setModel("");
    }
  };

  const handleProviderChange = (p: ProviderName) => {
    providerTouched.current = true;
    setProvider(p);
    if (p !== "claude") setModel("");
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!projectId || !prompt.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          prompt: prompt.trim(),
          provider,
          ...(model ? { model } : {}),
          ...(autonomy ? { autonomy } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to start session");
        return;
      }
      // 201 → open the stream on arrival. 202 (queued) → plain project
      // page; there's no run to stream yet, the queued badge carries it.
      window.location.href = data.queued
        ? `/project/${projectId}`
        : `/project/${projectId}?stream=${data.taskId}`;
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-xl">
      <Link
        href="/"
        className="text-sm text-zinc-400 transition hover:text-zinc-200"
      >
        ← Back to projects
      </Link>
      <h1 className="mt-3 text-xl font-semibold tracking-tight text-zinc-50">
        New session
      </h1>
      <p className="mt-1 text-sm text-zinc-400">
        Dispatches the provider CLI on your Mac under its own subscription
        login — no API billing.
      </p>

      {loadError ? (
        <p
          className="mt-4 rounded-md border border-kraken-alert/30 bg-kraken-alert/10 px-3 py-2 text-sm text-kraken-alert"
          role="alert"
        >
          {loadError}
        </p>
      ) : null}

      {!loading && !loadError && projects.length === 0 ? (
        <div className="mt-6 rounded-lg border border-dashed border-kraken-boundless p-8 text-center">
          <p aria-hidden="true" className="text-3xl">
            ⚓
          </p>
          <p className="mt-2 text-sm text-zinc-300">
            No projects in drydock yet.
          </p>
          <p className="mt-1 text-xs text-kraken-shadow">
            Add a project from the dashboard first — a session needs a repo
            to work in.
          </p>
        </div>
      ) : null}

      {projects.length > 0 ? (
        <form onSubmit={handleSubmit} className="mt-4 space-y-3">
          <label className="block text-sm">
            <span className="text-zinc-300">Project</span>
            <select
              value={projectId}
              onChange={(e) => handleProjectChange(e.target.value)}
              className="mt-1 block w-full min-h-[44px] rounded-md border border-kraken-boundless bg-kraken-deep px-3 text-zinc-50 focus:border-kraken-ice focus:outline-none"
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>

          <label className="block text-sm">
            <span className="text-zinc-300">Prompt</span>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              required
              rows={6}
              autoFocus
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
                    onClick={() => handleProviderChange(p)}
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

          <details className="rounded-lg border border-kraken-boundless bg-kraken-deep/40">
            <summary className="tap cursor-pointer select-none px-3 text-sm text-zinc-300">
              Advanced
            </summary>
            <div className="space-y-3 px-3 pb-3">
              <label className="block text-sm">
                <span className="text-zinc-300">Model</span>
                <select
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  disabled={provider !== "claude"}
                  className="mt-1 block w-full min-h-[44px] rounded-md border border-kraken-boundless bg-kraken-deep px-3 text-zinc-50 focus:border-kraken-ice focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <option value="">Default (routing rules decide)</option>
                  {CLAUDE_MODELS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
                {provider !== "claude" ? (
                  <span className="mt-1 block text-xs text-zinc-500">
                    Model choice applies to Claude only.
                  </span>
                ) : null}
              </label>

              <label className="block text-sm">
                <span className="text-zinc-300">Autonomy</span>
                <select
                  value={autonomy}
                  onChange={(e) =>
                    setAutonomy(e.target.value as "" | AutonomyLevel)
                  }
                  className="mt-1 block w-full min-h-[44px] rounded-md border border-kraken-boundless bg-kraken-deep px-3 text-zinc-50 focus:border-kraken-ice focus:outline-none"
                >
                  <option value="">
                    Project default ({selectedProject?.autonomy ?? "edits"})
                  </option>
                  <option value="readonly">Read-only</option>
                  <option value="edits">Edits</option>
                  <option value="full">Full</option>
                </select>
                <span className="mt-1 block text-xs text-zinc-500">
                  {AUTONOMY_HINTS[effectiveAutonomy]}
                </span>
              </label>
            </div>
          </details>

          {error ? (
            <p
              className="rounded-md border border-kraken-alert/30 bg-kraken-alert/10 px-3 py-2 text-sm text-kraken-alert"
              role="alert"
            >
              {error}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={busy || !projectId || !prompt.trim()}
            className="w-full min-h-[44px] rounded-md bg-kraken-ice px-3 text-sm font-semibold text-kraken-deep transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Starting…" : "Start session"}
          </button>
        </form>
      ) : null}
    </div>
  );
}
