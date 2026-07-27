"use client";

import { useCallback, useEffect, useState } from "react";
import { Disclosure } from "./Disclosure";

/**
 * The inbox (EP-12 Spec A) — everything captured but not yet accepted.
 *
 * ── Why a stage at all ──────────────────────────────────────────────────
 * Once Siri, iMessage, project files, GitHub, and a nightly idea
 * generator can all write to the backlog, "the backlog" stops being a
 * list the user trusts and becomes a feed they scroll past. The inbox is
 * the seam: raw captures land here, and one deliberate tap moves an item
 * into the list that Burn Down and the Apple Note actually see.
 *
 * ── One tap per item ────────────────────────────────────────────────────
 * The whole sweep for a typical morning (3–5 items) has to be under 30
 * seconds or it won't happen. Accept is one tap. Edit-then-accept and
 * discard are there for the cases that need them, but nothing is required
 * beyond Accept — an item with no project and no priority is still a
 * perfectly good backlog item.
 */

type BacklogStatus =
  | "idea"
  | "in_progress"
  | "done"
  | "dropped"
  | "proposed";

interface BacklogItem {
  id: string;
  title: string;
  description: string | null;
  project_id: string | null;
  status: BacklogStatus;
  priority: number;
  source: string;
  raw_capture: string | null;
  triaged_at: number | null;
  created_at: number;
}

interface Project {
  id: string;
  name: string;
}

/** Where each capture came from, in the user's terms. */
const SOURCE_CHIP: Record<string, { label: string; className: string }> = {
  shortcut: {
    label: "Siri",
    className: "border-kraken-ice/40 text-kraken-ice",
  },
  imessage: {
    label: "iMessage",
    className: "border-blue-500/40 text-blue-300",
  },
  "ai-generated": {
    label: "🤖 proposed",
    className: "border-violet-500/40 text-violet-300",
  },
  github: {
    label: "GitHub",
    className: "border-zinc-500/40 text-zinc-300",
  },
  "project-file": {
    label: "project file",
    className: "border-teal-500/40 text-teal-300",
  },
};

const PRIORITY_LABEL: Record<number, string> = {
  3: "p1",
  2: "p2",
  1: "p3",
};

export function InboxPanel({
  projects,
  onChange,
}: {
  projects: Project[];
  /** Called after any accept/discard so the parent list refetches. */
  onChange: () => void;
}) {
  const [items, setItems] = useState<BacklogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/backlog?stage=inbox");
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to load inbox");
      setItems(body.items as BacklogItem[]);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const accept = async (item: BacklogItem): Promise<void> => {
    setBusy(item.id);
    try {
      const res = await fetch(`/api/backlog/${item.id}/triage`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "Accept failed");
        return;
      }
      await refresh();
      onChange();
    } finally {
      setBusy(null);
    }
  };

  const discard = async (item: BacklogItem): Promise<void> => {
    setBusy(item.id);
    try {
      await fetch(`/api/backlog/${item.id}`, { method: "DELETE" });
      await refresh();
      onChange();
    } finally {
      setBusy(null);
    }
  };

  const assign = async (item: BacklogItem, projectId: string): Promise<void> => {
    setBusy(item.id);
    try {
      await fetch(`/api/backlog/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: projectId || null }),
      });
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  // Nothing in the inbox is the good state — don't take up a card saying
  // so. (Distinct from "still loading", which also shows nothing.)
  if (loading || items.length === 0) return null;

  return (
    <div className="mb-3">
      <Disclosure
        title="Inbox"
        defaultOpen
        accentClass="text-kraken-ice"
        badge={
          <span className="rounded-full bg-kraken-ice/15 px-2 py-0.5 text-[10px] font-semibold text-kraken-ice ring-1 ring-inset ring-kraken-ice/30">
            {items.length}
          </span>
        }
        summary="captured, not yet accepted"
      >
        {error ? (
          <p role="alert" className="mb-2 text-xs text-kraken-alert">
            {error}
          </p>
        ) : null}
        <ul className="space-y-2">
          {items.map((item) => {
            const chip = SOURCE_CHIP[item.source];
            // Show the raw capture when parsing changed it — that's the
            // moment the user needs to see what they actually said.
            const showRaw =
              item.raw_capture !== null &&
              item.raw_capture.trim() !== item.title;
            return (
              <li
                key={item.id}
                className="rounded-md border border-kraken-boundless/60 bg-kraken-surface p-3"
              >
                <p className="text-sm text-zinc-100">{item.title}</p>
                {showRaw ? (
                  <p className="mt-0.5 font-mono text-[10px] text-kraken-shadow">
                    said: {item.raw_capture}
                  </p>
                ) : null}
                {item.description ? (
                  <p className="mt-1 whitespace-pre-line text-[11px] text-kraken-shadow">
                    {item.description}
                  </p>
                ) : null}
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px]">
                  {chip ? (
                    <span
                      className={`rounded-full border px-1.5 py-0.5 ${chip.className}`}
                    >
                      {chip.label}
                    </span>
                  ) : null}
                  {PRIORITY_LABEL[item.priority] ? (
                    <span className="rounded-full border border-amber-500/40 px-1.5 py-0.5 text-amber-300">
                      {PRIORITY_LABEL[item.priority]}
                    </span>
                  ) : null}
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void accept(item)}
                    disabled={busy === item.id}
                    className="tap rounded-md bg-kraken-ice px-3 text-xs font-semibold text-kraken-deep transition hover:brightness-110 disabled:opacity-50"
                  >
                    Accept
                  </button>
                  <select
                    value={item.project_id ?? ""}
                    onChange={(e) => void assign(item, e.target.value)}
                    disabled={busy === item.id}
                    aria-label={`Assign project for ${item.title}`}
                    className="tap rounded-md border border-kraken-boundless bg-kraken-deep px-2 text-xs text-zinc-50 focus:border-kraken-ice focus:outline-none"
                  >
                    <option value="">Unassigned</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => void discard(item)}
                    disabled={busy === item.id}
                    aria-label={`Discard ${item.title}`}
                    title="Discard — this never reached the backlog or the Note."
                    className="ml-auto tap rounded-md px-2 text-base text-zinc-500 transition hover:text-kraken-alert"
                  >
                    🗑️
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </Disclosure>
    </div>
  );
}
