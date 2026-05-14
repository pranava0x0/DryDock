"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface BudgetRollup {
  periodStart: string;
  periodEnd: string;
  budgetUsd: number | null;
  spentUsd: number;
  remainingUsd: number | null;
  percentUsed: number | null;
  thresholdReached: 50 | 80 | 100 | null;
  lastAlertedPct: number | null;
}

/**
 * Header pill + banner combo for the monthly budget.
 *
 * Polls /api/budget every 30s so the rollup stays fresh without being
 * chatty. When `thresholdReached` outranks `lastAlertedPct`, it:
 *   1. shows an in-page banner (always),
 *   2. fires a browser Notification if the user has granted permission
 *      (free, no service worker required as long as the page is open),
 *   3. PUTs `acked_pct` back to the server so we won't re-alert.
 *
 * Why this design is the cheapest viable option: no third-party service,
 * no email, no SMS, no push subscription. The user has to have DryDock
 * open in a tab (or as a PWA) to see the alert — that's fine because
 * the dashboard is where they manage tasks anyway.
 */
export function BudgetWidget() {
  const [rollup, setRollup] = useState<BudgetRollup | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  // Tracks the threshold we've already fired a Notification for in THIS
  // tab, so we don't re-notify on every poll while waiting for the user
  // to ack on the server side.
  const notifiedRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/budget");
      const data = await res.json();
      if (res.ok) setRollup(data.budget);
    } catch {
      // ignore — next poll will retry
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    if (!rollup) return;
    const t = rollup.thresholdReached;
    if (t === null) return;
    if ((rollup.lastAlertedPct ?? 0) >= t) return; // already alerted server-side
    if (notifiedRef.current === t) return; // already alerted in this tab
    notifiedRef.current = t;

    // Best-effort browser notification. Permission may be 'default'
    // (we haven't asked yet) — in that case the banner still appears.
    if (
      typeof window !== "undefined" &&
      "Notification" in window &&
      Notification.permission === "granted"
    ) {
      try {
        new Notification(`⚓ DryDock budget`, {
          body: `You've used ${rollup.percentUsed?.toFixed(1)}% of your $${rollup.budgetUsd?.toFixed(2)} monthly budget.`,
          tag: `drydock-budget-${t}`,
        });
      } catch {
        // some browsers throw when constructed without a service worker
      }
    }

    void fetch("/api/budget", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ acked_pct: t }),
    });
  }, [rollup]);

  const handleSave = async () => {
    setBusy(true);
    try {
      const parsed = draft.trim() === "" ? null : Number.parseFloat(draft);
      const res = await fetch("/api/budget", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ budget_usd: parsed }),
      });
      const data = await res.json();
      if (res.ok) {
        setRollup(data.budget);
        setEditing(false);
        // Ask permission as a side effect of saving — feels natural
        // ("you set a budget; want a heads-up when you near it?").
        if (
          typeof window !== "undefined" &&
          "Notification" in window &&
          Notification.permission === "default"
        ) {
          void Notification.requestPermission();
        }
      }
    } finally {
      setBusy(false);
    }
  };

  if (!rollup) return null;

  const showBanner =
    rollup.thresholdReached !== null && !dismissed;

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setDraft(rollup.budgetUsd?.toString() ?? "");
          setEditing(true);
        }}
        className="hidden items-center gap-2 rounded-full border border-kraken-boundless bg-kraken-surface px-3 py-1 text-xs text-zinc-200 transition hover:border-kraken-ice/60 sm:inline-flex"
        aria-label="Edit monthly budget"
      >
        <span className="text-kraken-shadow">$</span>
        <span className="font-mono">{rollup.spentUsd.toFixed(2)}</span>
        <span className="text-kraken-shadow">
          / {rollup.budgetUsd !== null ? rollup.budgetUsd.toFixed(0) : "set"}
        </span>
        {rollup.percentUsed !== null ? (
          <span
            className={
              rollup.percentUsed >= 100
                ? "text-kraken-alert"
                : rollup.percentUsed >= 80
                  ? "text-amber-300"
                  : "text-kraken-ice"
            }
          >
            {rollup.percentUsed.toFixed(0)}%
          </span>
        ) : null}
      </button>

      {showBanner ? (
        <div
          className={`mb-4 flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm ${
            rollup.thresholdReached === 100
              ? "border-kraken-alert/40 bg-kraken-alert/10 text-kraken-alert"
              : "border-amber-500/40 bg-amber-500/10 text-amber-300"
          }`}
          role="alert"
        >
          <span>
            {rollup.thresholdReached === 100
              ? `Over budget — $${rollup.spentUsd.toFixed(2)} of $${rollup.budgetUsd?.toFixed(2)} used this month.`
              : `${rollup.thresholdReached}% of monthly budget used ($${rollup.spentUsd.toFixed(2)} / $${rollup.budgetUsd?.toFixed(2)}).`}
          </span>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="text-xs underline-offset-2 hover:underline"
          >
            dismiss
          </button>
        </div>
      ) : null}

      {editing ? (
        <div
          className="fixed inset-0 z-20 flex items-end justify-center bg-black/60 sm:items-center"
          role="dialog"
          aria-modal="true"
          aria-label="Set monthly budget"
          onClick={() => !busy && setEditing(false)}
        >
          <div
            className="w-full max-w-sm rounded-t-2xl border border-kraken-boundless bg-kraken-surface p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:rounded-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-zinc-50">
              Monthly budget
            </h2>
            <p className="mt-1 text-sm text-kraken-shadow">
              Sum of agent run costs this calendar month. Leave blank to
              clear; DryDock will still track spend.
            </p>
            <label className="mt-4 block text-sm">
              <span className="text-zinc-300">Budget (USD)</span>
              <input
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="50"
                className="mt-1 block w-full min-h-[44px] rounded-md border border-kraken-boundless bg-kraken-deep px-3 font-mono text-zinc-50 placeholder-zinc-600 focus:border-kraken-ice focus:outline-none"
              />
            </label>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => setEditing(false)}
                disabled={busy}
                className="flex-1 min-h-[44px] rounded-md border border-kraken-boundless px-3 text-sm font-medium text-zinc-200 transition hover:bg-kraken-boundless/30"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={busy}
                className="flex-1 min-h-[44px] rounded-md bg-kraken-ice px-3 text-sm font-semibold text-kraken-deep transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
