"use client";

import { useEffect, useState } from "react";
import { InlineDisclosure } from "./Disclosure";

/**
 * Settings → Backlog mirror (EP-13).
 *
 * "Somewhere more durable than a Notes list." One private tracker repo,
 * one issue per accepted backlog item.
 *
 * Clicks added to the daily flow: **zero**. This is a one-time field.
 * After it's set, mirroring happens inside the existing sync tick, and
 * the only visible change is that backlog rows gain a link out.
 */

interface MirrorState {
  repo: string | null;
  synced: {
    created: number;
    updated: number;
    closed: number;
    pulledUpdated: number;
    reAdopted: number;
    status: string;
    reason: string | null;
  } | null;
}

export function BacklogMirror() {
  const [repo, setRepo] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/backlog/mirror")
      .then((r) => r.json())
      .then((body: MirrorState) => {
        setSaved(body.repo);
        setRepo(body.repo ?? "");
      })
      .catch(() => {
        /* Settings still work without it. */
      });
  }, []);

  const save = async (create: boolean): Promise<void> => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const res = await fetch("/api/backlog/mirror", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: repo.trim() || null, create }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "Failed");
        return;
      }
      setSaved(body.repo);
      const s = (body as MirrorState).synced;
      if (!s) {
        setStatus("Mirror turned off.");
      } else if (s.status !== "ok") {
        setError(s.reason ?? "Mirror unavailable");
      } else {
        setStatus(
          `Synced — ${s.created} created, ${s.updated} updated, ${s.closed} closed` +
            (s.reAdopted > 0 ? `, ${s.reAdopted} re-linked` : ""),
        );
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-kraken-boundless bg-kraken-deep/40 p-4">
      <h2 className="text-sm font-medium text-zinc-100">Backlog mirror</h2>
      <p className="mt-1 text-xs text-kraken-shadow">
        Mirror accepted backlog items to one private GitHub repo, as issues.
      </p>
      <InlineDisclosure label="What exactly gets mirrored?">
        <p>
          Only items you&apos;ve <strong className="text-zinc-300">accepted</strong>.
          Inbox captures and machine-proposed ideas stay in the database —
          a durable tracker full of unswept captures is worse than no
          tracker.
        </p>
        <p>
          Open/closed <em>is</em> the status; there are no status labels,
          because a second representation of state is a second thing that
          can disagree with the first. Labels carry only the project and
          the source.
        </p>
        <p>
          Deleting an item in DryDock <strong className="text-zinc-300">closes</strong>{" "}
          its issue and never deletes it. The point of a durable mirror is
          that it survives things — including mistakes.
        </p>
        <p>
          Reopening an issue on GitHub reopens the item here. That
          deliberately differs from the Apple Note, where re-ticking a box
          does nothing: a reopen is deliberate, timestamped, and logged,
          with none of a checkbox&apos;s ambiguity.
        </p>
      </InlineDisclosure>

      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <input
          type="text"
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          placeholder="owner/backlog"
          aria-label="Tracker repository"
          className="min-h-[44px] flex-1 rounded-md border border-kraken-boundless bg-kraken-deep px-3 text-sm text-zinc-50 placeholder-zinc-600 focus:border-kraken-ice focus:outline-none"
        />
        <button
          type="button"
          onClick={() => void save(false)}
          disabled={busy}
          className="min-h-[44px] rounded-md bg-kraken-ice px-4 text-sm font-semibold text-kraken-deep transition hover:brightness-110 disabled:opacity-50"
        >
          {busy ? "Syncing…" : "Save & sync"}
        </button>
        {/* Creating a repo is outward-facing, so it's its own button
            rather than something "Save" might do by surprise. */}
        <button
          type="button"
          onClick={() => void save(true)}
          disabled={busy || repo.trim() === ""}
          title="Create this repo as private, then sync"
          className="min-h-[44px] rounded-md border border-kraken-boundless px-3 text-sm text-zinc-300 transition hover:bg-kraken-boundless/30 disabled:opacity-50"
        >
          Create it
        </button>
      </div>

      {saved ? (
        <p className="mt-2 text-[11px] text-kraken-shadow">
          Mirroring to{" "}
          <a
            href={`https://github.com/${saved}/issues`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-kraken-ice underline-offset-2 hover:underline"
          >
            {saved}
          </a>
        </p>
      ) : null}
      {status ? (
        <p className="mt-1 text-[11px] text-kraken-ice">{status}</p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-1 text-[11px] text-kraken-alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
