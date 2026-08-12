"use client";

import { useCallback, useState } from "react";
import type { ProjectBacklogScan } from "@/lib/connectors/project-backlogs";

/**
 * A project's own backlog file, parsed on demand.
 *
 * Lazy on purpose. Reading and parsing a markdown file per project is cheap
 * once and wasteful thirty times, so nothing is fetched until this section is
 * actually opened, and the result is kept for the life of the component so
 * collapsing and reopening doesn't re-read the disk.
 */
export function ProjectBacklog({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const [scan, setScan] = useState<ProjectBacklogScan | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    // Already have it, or already asking for it.
    if (scan || loading) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/backlog`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to read backlog");
      setScan(body.backlog);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [projectId, scan, loading]);

  return (
    <section className="mt-4 rounded-lg border border-kraken-boundless">
      <button
        type="button"
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) void load();
        }}
        aria-expanded={open}
        className="tap flex w-full items-center justify-between gap-2 px-3 text-left text-sm font-medium text-zinc-100"
      >
        <span>Project backlog</span>
        <span className="text-xs text-kraken-shadow">
          {scan
            ? scan.file
              ? `${scan.items.length} open${scan.skipped > 0 ? ` · ${scan.skipped} not shown` : ""}`
              : "none found"
            : open && loading
              ? "reading…"
              : open
                ? ""
                : "tap to load"}
        </span>
      </button>

      {open ? (
        <div className="border-t border-kraken-boundless px-3 py-2">
          {loading && !scan ? (
            <p className="dd-pulse text-xs text-kraken-shadow">
              Reading the project&apos;s backlog file…
            </p>
          ) : error ? (
            <p className="text-xs text-kraken-alert" role="alert">
              {error}
            </p>
          ) : !scan ? null : !scan.file ? (
            <p className="text-xs text-kraken-shadow">
              {/* The reason matters: no file at all is a different fact from a
                  file we failed to parse. */}
              {scan.reason ?? "No backlog file in this project."}
            </p>
          ) : (
            <>
              <p className="text-xs text-kraken-shadow">
                <span className="font-mono text-zinc-300">{scan.file}</span>
                {scan.completed.length > 0
                  ? ` · ${scan.completed.length} already done`
                  : ""}
              </p>

              {scan.items.length === 0 ? (
                <p className="mt-2 text-xs text-kraken-shadow">
                  Nothing open in this file.
                </p>
              ) : (
                <ul className="mt-2 space-y-1">
                  {scan.items.map((item) => (
                    <li
                      key={item.ordinal}
                      className="flex gap-2 text-xs text-zinc-200"
                    >
                      <span aria-hidden="true" className="text-kraken-shadow">
                        ·
                      </span>
                      <span className="min-w-0">
                        {item.title}
                        {item.section ? (
                          <span className="text-kraken-shadow"> — {item.section}</span>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              {scan.skipped > 0 ? (
                // Never let a capped list read as a complete one.
                <p className="mt-2 text-xs text-kraken-shadow">
                  {scan.skipped} further item{scan.skipped === 1 ? "" : "s"} in the
                  file beyond the per-project cap.
                </p>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
