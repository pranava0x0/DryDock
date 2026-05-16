"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PROVIDER_BUDGET_LINKS } from "@/lib/providers/budget-links";

interface SettingsResponse {
  settings: {
    auto_cleanup_worktree?: boolean;
  };
}

interface UsageWindow {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  sessions: number;
  assistantTurns: number;
}

interface ClaudeUsageReport {
  weekly: UsageWindow;
  monthly: UsageWindow;
  latestTurnAt: string | null;
  filesScanned: number;
  generatedAt: string;
}

interface ProviderBudgetsResponse {
  claude: ClaudeUsageReport | { error: string };
  codex: null;
  google: null;
  cachedAt: string;
}

// Intl compact-notation formatter for "2.4B" / "115M" / "11.1M" style.
// Created outside the component so React doesn't allocate a new Intl
// instance on every render.
const compact = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

function formatLatestTurn(iso: string | null): string {
  if (!iso) return "no turns yet";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "no turns yet";
  const elapsedMs = Date.now() - then;
  if (elapsedMs < 60_000) return "active now";
  if (elapsedMs < 3_600_000) return `${Math.floor(elapsedMs / 60_000)}m ago`;
  if (elapsedMs < 86_400_000) return `${Math.floor(elapsedMs / 3_600_000)}h ago`;
  return `${Math.floor(elapsedMs / 86_400_000)}d ago`;
}

function ClaudeBudgetCard({
  link,
  budgets,
  loading,
}: {
  link: (typeof PROVIDER_BUDGET_LINKS)[number];
  budgets: ProviderBudgetsResponse | null;
  loading: boolean;
}) {
  const claude = budgets?.claude;
  const hasError = claude !== undefined && "error" in (claude ?? {});
  const report = !hasError && claude ? (claude as ClaudeUsageReport) : null;

  return (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <span className="block text-sm font-medium text-zinc-100">
            {link.label}
          </span>
          <span className="block text-xs text-kraken-shadow">
            {loading
              ? "reading session logs…"
              : hasError
                ? `live read failed · ${link.host}`
                : report
                  ? `live from ~/.claude/projects · ${report.filesScanned} session log${report.filesScanned === 1 ? "" : "s"} · last turn ${formatLatestTurn(report.latestTurnAt)}`
                  : `deep-link only · ${link.host}`}
          </span>
        </div>
        <a
          href={link.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-[44px] shrink-0 items-center rounded-md border border-kraken-boundless px-3 text-xs font-medium text-kraken-ice transition hover:bg-kraken-boundless/30"
          aria-label={`Open ${link.label} billing in a new tab`}
        >
          Open ↗
        </a>
      </div>
      {report ? (
        <dl className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <UsageWindowBlock label="This week (rolling 7d)" window={report.weekly} />
          <UsageWindowBlock label="This month" window={report.monthly} />
        </dl>
      ) : null}
    </>
  );
}

function UsageWindowBlock({
  label,
  window,
}: {
  label: string;
  window: UsageWindow;
}) {
  return (
    <div className="rounded-md border border-kraken-boundless/40 bg-kraken-deep/60 p-3">
      <dt className="text-xs uppercase tracking-wide text-kraken-shadow">
        {label}
      </dt>
      <dd className="mt-1 space-y-0.5 text-xs">
        <div className="flex justify-between gap-2 text-zinc-200">
          <span className="text-kraken-shadow">in</span>
          <span className="font-mono">{compact.format(window.inputTokens)}</span>
        </div>
        <div className="flex justify-between gap-2 text-zinc-200">
          <span className="text-kraken-shadow">out</span>
          <span className="font-mono">{compact.format(window.outputTokens)}</span>
        </div>
        <div className="flex justify-between gap-2 text-zinc-200">
          <span className="text-kraken-shadow">cache create</span>
          <span className="font-mono">
            {compact.format(window.cacheCreationInputTokens)}
          </span>
        </div>
        <div className="flex justify-between gap-2 text-zinc-200">
          <span className="text-kraken-shadow">cache read</span>
          <span className="font-mono">
            {compact.format(window.cacheReadInputTokens)}
          </span>
        </div>
        <div className="mt-1 flex justify-between gap-2 border-t border-kraken-boundless/30 pt-1 text-zinc-300">
          <span className="text-kraken-shadow">
            {window.sessions} session{window.sessions === 1 ? "" : "s"}
          </span>
          <span className="font-mono">
            {compact.format(window.assistantTurns)} turns
          </span>
        </div>
      </dd>
    </div>
  );
}

export default function SettingsPage() {
  const [autoCleanup, setAutoCleanup] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [budgets, setBudgets] = useState<ProviderBudgetsResponse | null>(null);
  const [budgetsLoading, setBudgetsLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/settings");
      const data: SettingsResponse = await res.json();
      if (!res.ok) throw new Error((data as { error?: string }).error ?? "Failed to load");
      setAutoCleanup(Boolean(data.settings.auto_cleanup_worktree));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshBudgets = useCallback(async () => {
    setBudgetsLoading(true);
    try {
      const res = await fetch("/api/provider-budgets");
      const data: ProviderBudgetsResponse = await res.json();
      if (res.ok) setBudgets(data);
    } catch {
      // Falls back to the deep-link-only card layout. No need to surface
      // a banner — the Settings page still works for everything else.
    } finally {
      setBudgetsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    void refreshBudgets();
  }, [refresh, refreshBudgets]);

  const handleToggle = async (next: boolean) => {
    setSaving(true);
    setStatus(null);
    setError(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ auto_cleanup_worktree: next }),
      });
      const data: SettingsResponse = await res.json();
      if (!res.ok) {
        throw new Error(
          (data as { error?: string }).error ?? "Failed to save",
        );
      }
      setAutoCleanup(Boolean(data.settings.auto_cleanup_worktree));
      setStatus("Saved.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section>
      <div className="mb-4 flex items-baseline justify-between">
        <h1 className="text-xl font-semibold tracking-tight text-zinc-50">
          Settings
        </h1>
        <Link
          href="/"
          className="text-xs text-kraken-ice underline-offset-2 transition hover:underline"
        >
          ← Dashboard
        </Link>
      </div>

      {error ? (
        <p
          className="mb-4 rounded-md border border-kraken-alert/30 bg-kraken-alert/10 px-3 py-2 text-sm text-kraken-alert"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      {loading ? (
        <p className="text-sm text-kraken-shadow">loading…</p>
      ) : (
        <div className="space-y-4">
          <div className="rounded-lg border border-kraken-boundless bg-kraken-deep/40 p-4">
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={autoCleanup}
                disabled={saving}
                onChange={(e) => void handleToggle(e.target.checked)}
                className="mt-1 h-5 w-5 rounded border-kraken-boundless bg-kraken-deep text-kraken-ice focus:ring-2 focus:ring-kraken-ice"
                aria-describedby="auto-cleanup-help"
              />
              <span>
                <span className="block text-sm font-medium text-zinc-100">
                  Auto-clean worktrees on success
                </span>
                <span
                  id="auto-cleanup-help"
                  className="mt-1 block text-xs text-kraken-shadow"
                >
                  Removes the per-task git worktree after the agent succeeds (and
                  the quality gate passes, when configured). The branch itself
                  survives, so you can still <code>git checkout</code> it later.
                  Off by default — leave it off if you usually inspect agent
                  changes before merging.
                </span>
                {status ? (
                  <span className="mt-2 block text-xs text-kraken-ice">{status}</span>
                ) : null}
              </span>
            </label>
          </div>

          <div className="rounded-lg border border-kraken-boundless bg-kraken-deep/40 p-4">
            <h2 className="text-sm font-medium text-zinc-100">
              Provider budgets
            </h2>
            <p className="mt-1 text-xs text-kraken-shadow">
              Claude reads live from your local Claude Code session logs.
              Google AI Pro and OpenAI Codex subscriptions don&apos;t expose a
              public usage API, so those stay as deep-links to their own
              dashboards.
            </p>
            <ul className="mt-3 space-y-2">
              {PROVIDER_BUDGET_LINKS.map((p) => {
                if (p.key === "claude") {
                  return (
                    <li
                      key={p.key}
                      className="rounded-md border border-kraken-boundless/60 bg-kraken-surface px-3 py-2"
                    >
                      <ClaudeBudgetCard
                        link={p}
                        budgets={budgets}
                        loading={budgetsLoading}
                      />
                    </li>
                  );
                }
                return (
                  <li
                    key={p.key}
                    className="flex items-center justify-between gap-3 rounded-md border border-kraken-boundless/60 bg-kraken-surface px-3 py-2"
                  >
                    <div className="min-w-0">
                      <span className="block text-sm font-medium text-zinc-100">
                        {p.label}
                      </span>
                      <span className="block text-xs text-kraken-shadow">
                        deep-link only · {p.host}
                      </span>
                    </div>
                    <a
                      href={p.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex min-h-[44px] shrink-0 items-center rounded-md border border-kraken-boundless px-3 text-xs font-medium text-kraken-ice transition hover:bg-kraken-boundless/30"
                      aria-label={`Open ${p.label} usage page in a new tab`}
                    >
                      Open ↗
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}
