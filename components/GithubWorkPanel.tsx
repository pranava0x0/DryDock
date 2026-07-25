"use client";

import { useCallback, useEffect, useState } from "react";
import { Disclosure } from "./Disclosure";

/**
 * Open GitHub work, beside the backlog.
 *
 * The backlog answers "what could I do next"; this answers "what have I
 * already started that's waiting on me". Both belong on the same screen,
 * and neither is complete without the other — an open PR from three days
 * ago is far more urgent than any idea in the list.
 *
 * PRs are read-only links out. They are deliberately NOT imported as
 * backlog rows: every action this page offers ("burn down", "mark done")
 * is wrong for a pull request, and importing them would double-count work
 * against the ideas that actually need triage. Issues are different and
 * do flow in — an issue is a unit of intended work.
 */

interface Pull {
  id: string;
  number: number;
  repository: string;
  title: string;
  url: string;
  isDraft: boolean;
  updatedAt: string;
}

interface Issue {
  id: string;
  number: number;
  repository: string;
  title: string;
  url: string;
  updatedAt: string;
  labels: string[];
}

interface GithubWork {
  status: "ok" | "unavailable";
  reason: string | null;
  login: string | null;
  pulls: Pull[];
  issues: Issue[];
  imported: { created: number; linked: number; reason: string | null } | null;
}

function fmtAge(iso: string): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "1d";
  if (days < 90) return `${days}d`;
  if (days < 730) return `${Math.round(days / 30)}mo`;
  return `${Math.round(days / 365)}y`;
}

export function GithubWorkPanel({ onChange }: { onChange: () => void }) {
  const [data, setData] = useState<GithubWork | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (withImport = false) => {
    try {
      const res = await fetch(
        `/api/backlog/github${withImport ? "?import=1" : ""}`,
      );
      const body = await res.json();
      setData(body as GithubWork);
    } catch {
      setData({
        status: "unavailable",
        reason: "could not reach the DryDock server",
        login: null,
        pulls: [],
        issues: [],
        imported: null,
      });
    } finally {
      setLoading(false);
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return null;
  if (!data) return null;

  // An unavailable `gh` says so — an empty list would read as "nothing is
  // open", which is a very different and much more relaxing message.
  if (data.status !== "ok") {
    return (
      <div className="mb-3">
        <Disclosure
          title="GitHub"
          summary="unavailable"
          badge={
            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] text-amber-200 ring-1 ring-inset ring-amber-500/30">
              ⚠
            </span>
          }
        >
          <p className="text-xs text-kraken-shadow">
            Can&apos;t read your open work: {data.reason}. Everything else on
            this page still works.
          </p>
        </Disclosure>
      </div>
    );
  }

  const total = data.pulls.length + data.issues.length;
  if (total === 0) return null;

  return (
    <div className="mb-3">
      <Disclosure
        title="Open on GitHub"
        summary={`${data.pulls.length} PR${data.pulls.length === 1 ? "" : "s"} · ${data.issues.length} issue${data.issues.length === 1 ? "" : "s"}`}
      >
        {data.reason ? (
          <p className="mb-2 text-[11px] text-amber-200">⚠ {data.reason}</p>
        ) : null}

        {data.pulls.length > 0 ? (
          <>
            <h4 className="text-[11px] uppercase tracking-wide text-kraken-shadow">
              Pull requests — waiting on you
            </h4>
            <ul className="mt-1.5 space-y-1">
              {data.pulls.map((pr) => (
                <li key={pr.id}>
                  <a
                    href={pr.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex min-h-[44px] items-center gap-2 rounded-md px-2 text-xs transition hover:bg-kraken-boundless/20"
                  >
                    <span className="min-w-0 flex-1 truncate text-zinc-200">
                      {pr.isDraft ? (
                        <span className="mr-1 text-kraken-shadow">draft</span>
                      ) : null}
                      {pr.title}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-kraken-shadow">
                      {pr.repository.split("/").pop()}#{pr.number}
                    </span>
                    <span className="w-10 shrink-0 text-right text-[10px] text-kraken-shadow">
                      {fmtAge(pr.updatedAt)}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </>
        ) : null}

        {data.issues.length > 0 ? (
          <>
            <h4 className="mt-3 text-[11px] uppercase tracking-wide text-kraken-shadow">
              Issues
            </h4>
            <ul className="mt-1.5 space-y-1">
              {data.issues.map((issue) => (
                <li key={issue.id}>
                  <a
                    href={issue.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex min-h-[44px] items-center gap-2 rounded-md px-2 text-xs transition hover:bg-kraken-boundless/20"
                  >
                    <span className="min-w-0 flex-1 truncate text-zinc-200">
                      {issue.title}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-kraken-shadow">
                      {issue.repository.split("/").pop()}#{issue.number}
                    </span>
                    {/* Age is load-bearing here: these lists reach back
                        years, and an ancient issue is only obviously
                        ancient if it says so. */}
                    <span className="w-10 shrink-0 text-right text-[10px] text-kraken-shadow">
                      {fmtAge(issue.updatedAt)}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={() => {
                setBusy(true);
                void load(true).then(onChange);
              }}
              disabled={busy}
              className="mt-2 min-h-[36px] rounded-md border border-kraken-boundless px-3 text-xs text-zinc-300 transition hover:bg-kraken-boundless/30 disabled:opacity-50"
            >
              {busy ? "filing…" : "File issues into the backlog"}
            </button>
            {data.imported ? (
              <p className="mt-1.5 text-[11px] text-kraken-shadow">
                Filed {data.imported.created} new,{" "}
                {data.imported.linked} linked to existing rows.
              </p>
            ) : null}
          </>
        ) : null}
      </Disclosure>
    </div>
  );
}
