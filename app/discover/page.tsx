"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { StackChip } from "@/components/StackChip";

interface DiscoveredProject {
  name: string;
  path: string;
  stack: string[];
  isGitRepo: boolean;
  alreadyImported: boolean;
}

interface DiscoverResponse {
  root: string;
  projects: DiscoveredProject[];
}

export default function DiscoverPage() {
  const [data, setData] = useState<DiscoverResponse | null>(null);
  const [rootInput, setRootInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // `importing` is the path of the project currently being imported, so we
  // can show a per-row spinner instead of disabling the whole list.
  const [importing, setImporting] = useState<string | null>(null);

  const fetchDiscovery = useCallback(async (root?: string) => {
    setLoading(true);
    setError(null);
    try {
      const url = root
        ? `/api/discover?root=${encodeURIComponent(root)}`
        : "/api/discover";
      const res = await fetch(url);
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "Failed to scan");
        setData(null);
        return;
      }
      setData(body);
      setRootInput(body.root);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchDiscovery();
  }, [fetchDiscovery]);

  const handleImport = async (project: DiscoveredProject) => {
    setImporting(project.path);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: project.name,
          path: project.path,
          // Stack chips imply a sensible default — Next/Node projects
          // probably want `npm test` as their gate; Python wants pytest.
          test_command: suggestedTestCommand(project.stack) ?? null,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "Import failed");
        return;
      }
      // Refresh so this row flips to "Imported."
      await fetchDiscovery(rootInput);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setImporting(null);
    }
  };

  return (
    <>
      <Link
        href="/"
        className="text-sm text-zinc-400 transition hover:text-zinc-200"
      >
        ← Back to projects
      </Link>
      <header className="mt-3 mb-4">
        <h1 className="text-xl font-semibold tracking-tight text-zinc-50">
          Discover projects
        </h1>
        <p className="mt-1 text-sm text-kraken-shadow">
          Subdirectories under your projects root. Already-imported ones are
          marked; click Import on the rest.
        </p>
      </header>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void fetchDiscovery(rootInput.trim() || undefined);
        }}
        className="mb-4 flex items-center gap-2"
      >
        <input
          type="text"
          value={rootInput}
          onChange={(e) => setRootInput(e.target.value)}
          aria-label="Scan root"
          className="flex-1 min-h-[44px] rounded-md border border-kraken-boundless bg-kraken-deep px-3 font-mono text-sm text-zinc-50 placeholder-zinc-600 focus:border-kraken-ice focus:outline-none"
          placeholder="/Users/you/Documents/Projects"
        />
        <button
          type="submit"
          className="inline-flex min-h-[44px] items-center rounded-md border border-kraken-boundless px-3 text-sm text-zinc-200 transition hover:bg-kraken-boundless/30"
        >
          Scan
        </button>
      </form>

      {error ? (
        <p
          className="mb-4 rounded-md border border-kraken-alert/30 bg-kraken-alert/10 px-3 py-2 text-sm text-kraken-alert"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      {loading ? (
        <p className="text-sm text-kraken-shadow">Scanning…</p>
      ) : data && data.projects.length === 0 ? (
        <div className="rounded-lg border border-dashed border-kraken-boundless p-8 text-center">
          <p aria-hidden="true" className="text-3xl">🏗️</p>
          <p className="mt-2 text-sm text-zinc-300">
            No subdirectories found under <span className="font-mono">{data.root}</span>.
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {data?.projects.map((p) => (
            <li
              key={p.path}
              className="rounded-lg border border-kraken-boundless bg-kraken-surface p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate text-base font-semibold text-zinc-50">
                    {p.name}
                  </h3>
                  <p className="mt-1 truncate font-mono text-xs text-kraken-shadow">
                    {p.path}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {p.stack.length === 0 ? (
                      <span className="text-xs text-kraken-shadow">no stack detected</span>
                    ) : (
                      p.stack.map((s) => <StackChip key={s} label={s} />)
                    )}
                    {p.isGitRepo ? (
                      <span className="inline-flex items-center rounded-full bg-kraken-boundless/40 px-2 py-0.5 text-xs text-zinc-300">
                        git
                      </span>
                    ) : null}
                  </div>
                </div>
                <div className="flex-shrink-0">
                  {p.alreadyImported ? (
                    <span className="inline-flex min-h-[44px] items-center rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 text-sm font-medium text-emerald-300">
                      Imported
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleImport(p)}
                      disabled={importing === p.path}
                      className="inline-flex min-h-[44px] items-center rounded-md bg-kraken-ice px-4 text-sm font-semibold text-kraken-deep shadow-sm transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {importing === p.path ? "Importing…" : "Import"}
                    </button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * Sensible defaults for the quality-gate command, based on detected stack.
 * Returning null means "skip the gate" — the user can edit later if they
 * want one.
 */
function suggestedTestCommand(stack: string[]): string | null {
  if (stack.includes("next") || stack.includes("node") || stack.includes("vite") || stack.includes("pnpm")) {
    return "npm test";
  }
  if (stack.includes("python")) return "pytest -q";
  if (stack.includes("rust")) return "cargo test";
  if (stack.includes("go")) return "go test ./...";
  return null;
}
