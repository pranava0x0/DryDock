"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Quick-add: one field, two taps (EP-12 Spec B).
 *
 * ── Why this exists next to the full form ───────────────────────────────
 * The full backlog form asks for a title AND a project before you can
 * submit, which is the right shape when you're sitting down to plan and
 * exactly the wrong shape when an idea arrives while you're doing
 * something else. Every field between the thought and the save is a
 * chance to lose it. So: FAB → type → Add. Project and priority are
 * optional trailing markers (`#drydock`, `p2`) for anyone who wants them,
 * and the item lands in the inbox where the rest can be filled in later.
 *
 * This does not replace the full form; it sits beside it. Deliberate
 * planning and hurried capture are different jobs.
 */
export function QuickAdd({ onAdded }: { onAdded?: () => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Escape closes. A sheet you can't dismiss without aiming at a small
  // target is a sheet that traps you.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: value,
          source: "shortcut",
          // A client-generated key so a double-tap on a slow connection
          // is one row, not two.
          idempotency_key: `quickadd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFlash(body.error ?? "Capture failed");
        return;
      }
      setText("");
      setOpen(false);
      setFlash(
        body.outcome === "duplicate"
          ? "Already in the backlog"
          : `Captured: ${body.parsed?.title ?? value}`,
      );
      onAdded?.();
    } finally {
      setBusy(false);
    }
  };

  // Confirmation clears itself — a capture is a fire-and-forget gesture,
  // and a toast that needs dismissing turns two taps back into three.
  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(null), 3500);
    return () => clearTimeout(timer);
  }, [flash]);

  return (
    <>
      {flash ? (
        <p
          role="status"
          className="fixed inset-x-4 bottom-[max(5.5rem,calc(env(safe-area-inset-bottom)+5.5rem))] z-40 mx-auto max-w-sm rounded-md border border-kraken-ice/40 bg-kraken-surface px-3 py-2 text-center text-xs text-kraken-ice shadow-lg"
        >
          {flash}
        </p>
      ) : null}

      {open ? (
        <div className="fixed inset-0 z-40 flex items-end sm:items-center sm:justify-center">
          <button
            type="button"
            aria-label="Close quick add"
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-black/50"
          />
          <form
            onSubmit={submit}
            className="relative w-full rounded-t-2xl border-t border-kraken-boundless bg-kraken-surface p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:max-w-md sm:rounded-2xl sm:border"
          >
            <label
              htmlFor="quick-add-input"
              className="block text-sm font-medium text-zinc-100"
            >
              Capture an idea
            </label>
            <input
              id="quick-add-input"
              ref={inputRef}
              type="text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="rate limiter for the tunnel p2 #drydock"
              className="mt-2 min-h-[44px] w-full rounded-md border border-kraken-boundless bg-kraken-deep px-3 text-base text-zinc-50 placeholder-zinc-600 focus:border-kraken-ice focus:outline-none"
            />
            <p className="mt-1.5 text-[11px] text-kraken-shadow">
              Optional trailing markers: <code>#project</code> and{" "}
              <code>p1</code>–<code>p4</code>. Lands in the inbox — accept it
              later.
            </p>
            <div className="mt-3 flex gap-2">
              <button
                type="submit"
                disabled={busy || text.trim() === ""}
                className="min-h-[44px] flex-1 rounded-md bg-kraken-ice px-4 text-sm font-semibold text-kraken-deep transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? "Adding…" : "Add"}
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="min-h-[44px] rounded-md border border-kraken-boundless px-4 text-sm text-zinc-300 transition hover:bg-kraken-boundless/30"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Quick add to backlog"
        className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] right-4 z-10 flex h-14 w-14 items-center justify-center rounded-full bg-kraken-ice text-2xl text-kraken-deep shadow-lg transition hover:brightness-110"
      >
        <span aria-hidden="true">+</span>
      </button>
    </>
  );
}
