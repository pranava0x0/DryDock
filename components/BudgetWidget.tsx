"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  CREDITS_KEY,
  currentUsageWindow,
  formatCountdown,
} from "@/lib/budget/window";

/**
 * Header summary pill for usage across all services in the current window
 * (calendar month). Shows combined tokens (Claude + Codex) and the time
 * until the window resets; clicking opens a per-service breakdown with the
 * window-elapsed percentage and an optional manual API-credits balance.
 *
 * Data comes from /api/provider-budgets (the same cached reader the
 * Settings cards use) so the header and the cards always agree. Window
 * timing is computed client-side from a ticking clock so the countdown
 * stays live without polling. Google reports activity (turns), not tokens,
 * so it's shown in the breakdown but excluded from the token total.
 *
 * The widget never throws on a per-provider read error — it's mounted in
 * the global header, so a failed read just contributes zero rather than
 * blanking every page.
 */

interface ClaudeWindow {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

interface CodexWindow {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

interface GeminiWindow {
  modelTurns: number;
}

type Report<T> = { monthly: T } | { error: string };

interface ProviderBudgetsResponse {
  claude: Report<ClaudeWindow>;
  codex: Report<CodexWindow>;
  google: Report<GeminiWindow>;
}

const compact = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

function monthly<T>(report: Report<T> | undefined): T | null {
  if (!report || "error" in report) return null;
  return report.monthly;
}

function claudeTokens(w: ClaudeWindow | null): number {
  if (!w) return 0;
  return (
    w.inputTokens +
    w.outputTokens +
    w.cacheCreationInputTokens +
    w.cacheReadInputTokens
  );
}

function codexTokens(w: CodexWindow | null): number {
  if (!w) return 0;
  return (
    w.inputTokens + w.cachedInputTokens + w.outputTokens + w.reasoningOutputTokens
  );
}

export function BudgetWidget() {
  const [budgets, setBudgets] = useState<ProviderBudgetsResponse | null>(null);
  const [credits, setCredits] = useState<number | null>(null);
  const [now, setNow] = useState<Date>(() => new Date());
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [pbRes, sRes] = await Promise.all([
        fetch("/api/provider-budgets"),
        fetch("/api/settings"),
      ]);
      if (pbRes.ok) setBudgets(await pbRes.json());
      if (sRes.ok) {
        const data = await sRes.json();
        const c = data?.settings?.[CREDITS_KEY];
        setCredits(typeof c === "number" ? c : null);
      }
    } catch {
      // keep last good values — next poll retries
    }
  }, []);

  // Poll provider budgets every 60s (the API caches for 60s server-side).
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 60_000);
    return () => clearInterval(t);
  }, [refresh]);

  // Tick the clock every 30s so the countdown + elapsed bar stay live
  // without re-fetching anything.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  if (!budgets) return null;

  const claude = monthly(budgets.claude);
  const codex = monthly(budgets.codex);
  const google = monthly(budgets.google);
  const cTok = claudeTokens(claude);
  const xTok = codexTokens(codex);
  const totalTok = cTok + xTok;
  const win = currentUsageWindow(now);
  const monthLabel = new Date(win.startISO).toLocaleString(undefined, {
    month: "long",
    year: "numeric",
  });
  const resetLabel = new Date(win.endISO).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
  });

  const handleSaveCredits = async () => {
    setBusy(true);
    try {
      const parsed = draft.trim() === "" ? null : Number.parseFloat(draft);
      if (parsed !== null && (!Number.isFinite(parsed) || parsed < 0)) {
        setBusy(false);
        return;
      }
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [CREDITS_KEY]: parsed }),
      });
      if (res.ok) {
        const data = await res.json();
        const c = data?.settings?.[CREDITS_KEY];
        setCredits(typeof c === "number" ? c : null);
        setEditing(false);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setDraft(credits?.toString() ?? "");
          setEditing(true);
        }}
        className="inline-flex items-center gap-2 rounded-full border border-kraken-boundless bg-kraken-surface px-3 py-1 text-xs text-zinc-200 transition hover:border-kraken-ice/60"
        aria-label={`Usage this window: ${compact.format(totalTok)} tokens, resets in ${formatCountdown(win.secondsUntilReset)}`}
      >
        <span className="font-mono">{compact.format(totalTok)}</span>
        <span className="text-kraken-shadow">tok</span>
        <span className="text-kraken-boundless">·</span>
        <span className="text-kraken-ice">
          {formatCountdown(win.secondsUntilReset)} left
        </span>
        {credits !== null ? (
          <>
            <span className="text-kraken-boundless">·</span>
            <span className="font-mono text-emerald-300">
              ${credits.toFixed(2)}
            </span>
            <span className="text-kraken-shadow">cr</span>
          </>
        ) : null}
      </button>

      {editing && typeof document !== "undefined" ? createPortal(
        <div
          className="fixed inset-0 z-20 flex items-end justify-center bg-black/60 sm:items-center sm:py-6"
          role="dialog"
          aria-modal="true"
          aria-label="Usage this window"
          onClick={() => !busy && setEditing(false)}
        >
          <div
            className="w-full max-w-sm overflow-y-auto rounded-t-2xl border border-kraken-boundless bg-kraken-surface p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:rounded-2xl max-h-[90vh]"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-zinc-50">
              Usage this window
            </h2>
            <p className="mt-1 text-sm text-kraken-shadow">
              {monthLabel} · resets {resetLabel} (in{" "}
              {formatCountdown(win.secondsUntilReset)})
            </p>

            {/* Window-elapsed progress */}
            <div className="mt-3">
              <div className="flex justify-between text-xs text-kraken-shadow">
                <span>{win.elapsedPct.toFixed(0)}% through this window</span>
                <span>{formatCountdown(win.secondsUntilReset)} left</span>
              </div>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-kraken-deep">
                <div
                  className="h-full rounded-full bg-kraken-ice"
                  style={{ width: `${win.elapsedPct}%` }}
                />
              </div>
            </div>

            {/* Per-service breakdown */}
            <dl className="mt-4 space-y-1 text-sm">
              <BreakdownRow
                label="Claude"
                value={claude ? `${compact.format(cTok)} tokens` : "—"}
              />
              <BreakdownRow
                label="OpenAI Codex"
                value={codex ? `${compact.format(xTok)} tokens` : "—"}
              />
              <BreakdownRow
                label="Google AI"
                value={
                  google
                    ? `${compact.format(google.modelTurns)} turns`
                    : "—"
                }
                muted
              />
              <div className="my-1 border-t border-kraken-boundless/40" />
              <BreakdownRow
                label="Total tokens"
                value={compact.format(totalTok)}
                strong
              />
            </dl>
            <p className="mt-1 text-[11px] leading-snug text-kraken-shadow">
              Tokens are Claude + Codex (all categories). Google reports
              activity, not tokens. Full breakdown in Settings → Provider
              budgets.
            </p>

            {/* Optional manual API credits */}
            <label className="mt-4 block text-sm">
              <span className="text-zinc-300">API credits (USD)</span>
              <input
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="none"
                className="mt-1 block w-full min-h-[44px] rounded-md border border-kraken-boundless bg-kraken-deep px-3 font-mono text-zinc-50 placeholder-zinc-600 focus:border-kraken-ice focus:outline-none"
              />
              <span className="mt-1 block text-[11px] text-kraken-shadow">
                Prepaid API balance, entered by hand (there&apos;s no usage
                API to read it). Leave blank to hide.
              </span>
            </label>

            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => setEditing(false)}
                disabled={busy}
                className="flex-1 min-h-[44px] rounded-md border border-kraken-boundless px-3 text-sm font-medium text-zinc-200 transition hover:bg-kraken-boundless/30"
              >
                Close
              </button>
              <button
                type="button"
                onClick={handleSaveCredits}
                disabled={busy}
                className="flex-1 min-h-[44px] rounded-md bg-kraken-ice px-3 text-sm font-semibold text-kraken-deep transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? "Saving…" : "Save credits"}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </>
  );
}

function BreakdownRow({
  label,
  value,
  muted,
  strong,
}: {
  label: string;
  value: string;
  muted?: boolean;
  strong?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className={muted ? "text-kraken-shadow" : "text-zinc-300"}>
        {label}
      </dt>
      <dd
        className={
          strong
            ? "font-mono font-semibold text-zinc-50"
            : "font-mono text-zinc-200"
        }
      >
        {value}
      </dd>
    </div>
  );
}
