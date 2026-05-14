"use client";

import { useCallback, useEffect, useState } from "react";

interface Doc {
  name: string;
  exists: boolean;
  size: number;
  content?: string;
  truncated?: boolean;
}

interface ProjectDocsProps {
  projectId: string;
}

/**
 * Collapsible reader for the small set of "what's happening in this
 * project" docs (issues.md, backlog.md, CLAUDE.md, etc.). Lazy-fetches
 * on first expand so a project detail page with 10 visible projects
 * doesn't make 70 markdown requests on load.
 */
export function ProjectDocs({ projectId }: ProjectDocsProps) {
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchDocs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/docs`);
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "Failed to load");
        return;
      }
      setDocs(body.docs);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (open && docs === null) void fetchDocs();
  }, [open, docs, fetchDocs]);

  const present = (docs ?? []).filter((d) => d.exists);

  return (
    <section className="mt-6">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between rounded-md border border-kraken-boundless bg-kraken-surface px-4 py-3 text-left transition hover:bg-kraken-boundless/30"
        aria-expanded={open}
      >
        <span className="text-sm font-medium uppercase tracking-wide text-zinc-300">
          Project docs
        </span>
        <span className="text-xs text-kraken-shadow">
          {open ? "hide" : "show"} {docs ? `(${present.length})` : ""}
        </span>
      </button>

      {open ? (
        <div className="mt-3 space-y-2">
          {loading ? (
            <p className="text-sm text-kraken-shadow">Loading…</p>
          ) : error ? (
            <p
              className="rounded-md border border-kraken-alert/30 bg-kraken-alert/10 px-3 py-2 text-sm text-kraken-alert"
              role="alert"
            >
              {error}
            </p>
          ) : present.length === 0 ? (
            <p className="text-sm text-kraken-shadow">
              No issues.md / backlog.md / CLAUDE.md in this project yet.
            </p>
          ) : (
            // Let <details> own its open/closed state — React 19 nulls out
            // synthetic event currentTarget after the handler returns, so
            // controlled-mode <details> was crashing on toggle.
            present.map((doc) => (
              <details
                key={doc.name}
                className="rounded-md border border-kraken-boundless bg-kraken-surface"
              >
                <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-2 text-sm font-medium text-zinc-200">
                  <span className="font-mono">{doc.name}</span>
                  <span className="text-xs text-kraken-shadow">
                    {formatSize(doc.size)}
                    {doc.truncated ? " · head only" : ""}
                  </span>
                </summary>
                <pre className="stream-output max-h-[60vh] overflow-y-auto border-t border-kraken-boundless px-4 py-3 text-xs text-zinc-200">
                  {doc.content ?? ""}
                </pre>
              </details>
            ))
          )}
        </div>
      ) : null}
    </section>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
