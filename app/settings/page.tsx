"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { PROVIDER_BUDGET_LINKS } from "@/lib/providers/budget-links";
import { createThrottleGate } from "@/lib/util/throttle-gate";
import { createIdleBackoff } from "@/lib/util/idle-backoff";
import {
  CLAUDE_MODELS,
  type RoutingRule,
} from "@/lib/routing/rules";
import type { ProviderName } from "@/lib/providers/types";
import { SubscriptionEditor } from "@/components/SubscriptionEditor";
import { InlineDisclosure } from "@/components/Disclosure";
import { BacklogMirror } from "@/components/BacklogMirror";

// Idle-backoff knobs for the Claude budget refresh. baseMs lines up with
// the throttle gate's 1/min cap (so a backoff fire never gets blocked at
// its first attempt). maxMs caps the interval — a tab left idle for
// hours still refreshes at least once every 30 minutes.
const IDLE_BACKOFF_BASE_MS = 60_000;
const IDLE_BACKOFF_MAX_MS = 30 * 60_000;

interface SettingsResponse {
  settings: {
    auto_cleanup_worktree?: boolean;
    max_concurrent_runs?: number;
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
  fiveHour: UsageWindow;
  weekly: UsageWindow;
  monthly: UsageWindow;
  latestTurnAt: string | null;
  filesScanned: number;
  generatedAt: string;
}

interface GeminiActivityWindow {
  userPrompts: number;
  modelTurns: number;
  toolCalls: number;
  conversations: number;
}

/** The `agy` CLI's separate SQLite store (DD-BL-38). */
interface AntigravityCliReport {
  health: "ok" | "no-data" | "unavailable";
  reason: string | null;
  databases: number;
  events: number;
  conversations: number;
}

interface GeminiUsageReport {
  weekly: GeminiActivityWindow;
  monthly: GeminiActivityWindow;
  latestActivityAt: string | null;
  conversationsScanned: number;
  generatedAt: string;
  cli: AntigravityCliReport;
}

interface CodexUsageWindow {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  sessions: number;
  turns: number;
}

interface CodexUsageReport {
  weekly: CodexUsageWindow;
  monthly: CodexUsageWindow;
  latestTurnAt: string | null;
  filesScanned: number;
  generatedAt: string;
}

interface ProviderBudgetsResponse {
  claude: ClaudeUsageReport | { error: string };
  codex: CodexUsageReport | { error: string };
  google: GeminiUsageReport | { error: string };
  cachedAt: string;
  /**
   * The server served a cached payload and is re-reading the logs behind it.
   * Worth showing: the scan takes seconds, so "these numbers are a moment
   * old and moving" is materially different from "these numbers are live".
   */
  refreshing?: boolean;
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

/** "as of 21:47:02" — clock time, since this is a read timestamp, not an age. */
function formatAsOf(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "unknown";
  return at.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * When the numbers were read, and whether a re-read is running.
 *
 * Distinct from each card's "last turn Nm ago", which is the freshness of the
 * underlying *logs*. This is the freshness of our *read* of them — the two
 * come apart precisely because the scan is slow enough to be served stale.
 */
function FreshnessLine({
  budgets,
  loading,
}: {
  budgets: ProviderBudgetsResponse | null;
  loading: boolean;
}) {
  if (loading && !budgets) {
    return (
      <p className="mt-1 text-xs text-kraken-shadow">
        <span className="dd-pulse">Reading local logs…</span>
      </p>
    );
  }
  if (!budgets) return null;

  return (
    <p className="mt-1 flex items-center gap-1.5 text-xs text-kraken-shadow">
      <span>as of {formatAsOf(budgets.cachedAt)}</span>
      {budgets.refreshing ? (
        <>
          {/* Two-frame opacity pulse on a 5px dot: no layout, no repaint of
              anything but the dot, and it stops the moment the refresh lands.
              `prefers-reduced-motion` pins it solid — see globals.css. */}
          <span
            aria-hidden="true"
            className="dd-pulse inline-block h-[5px] w-[5px] rounded-full bg-kraken-ice"
          />
          <span className="dd-pulse">refreshing</span>
        </>
      ) : null}
    </p>
  );
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
        <>
          <dl className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
            <UsageWindowBlock label="Last 5h (session window)" window={report.fiveHour} highlight />
            <UsageWindowBlock label="This week (rolling 7d)" window={report.weekly} />
            <UsageWindowBlock label="This month" window={report.monthly} />
          </dl>
          <p className="mt-1.5 text-[11px] text-kraken-shadow">
            5h window matches Claude Code&apos;s session rate-limit period.
          </p>
        </>
      ) : null}
    </>
  );
}

function UsageWindowBlock({
  label,
  window,
  highlight,
}: {
  label: string;
  window: UsageWindow;
  highlight?: boolean;
}) {
  return (
    <div className={`rounded-md border p-3 ${highlight ? "border-kraken-ice/40 bg-kraken-ice/5" : "border-kraken-boundless/40 bg-kraken-deep/60"}`}>
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

function GoogleBudgetCard({
  link,
  budgets,
  loading,
}: {
  link: (typeof PROVIDER_BUDGET_LINKS)[number];
  budgets: ProviderBudgetsResponse | null;
  loading: boolean;
}) {
  const google = budgets?.google;
  const hasError = google !== undefined && "error" in (google ?? {});
  const report = !hasError && google ? (google as GeminiUsageReport) : null;
  const hasActivity =
    report !== null && report.conversationsScanned > 0;

  return (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <span className="block text-sm font-medium text-zinc-100">
            {link.label}
          </span>
          <span className="block text-xs text-kraken-shadow">
            {loading
              ? "reading activity logs…"
              : hasError
                ? `live read failed · ${link.host}`
                : hasActivity
                  ? `local Antigravity activity · ${report!.conversationsScanned} conversation${report!.conversationsScanned === 1 ? "" : "s"} · last turn ${formatLatestTurn(report!.latestActivityAt)}`
                  : `no local activity · ${link.host}`}
          </span>
        </div>
        <a
          href={link.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-[44px] shrink-0 items-center rounded-md border border-kraken-boundless px-3 text-xs font-medium text-kraken-ice transition hover:bg-kraken-boundless/30"
          aria-label={`Open ${link.label} in a new tab`}
        >
          Open ↗
        </a>
      </div>
      {hasActivity ? (
        <>
          <dl className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <GeminiActivityBlock
              label="This week (rolling 7d)"
              window={report!.weekly}
            />
            <GeminiActivityBlock label="This month" window={report!.monthly} />
          </dl>
          <p className="mt-2 text-[11px] leading-snug text-kraken-shadow">
            Activity, not tokens — Google records no token counts locally.
          </p>
        </>
      ) : null}
      {/* The `agy` CLI keeps its own SQLite store, separate from the IDE
          logs above. Only mentioned when it has something to say: an
          "unavailable" chip on a machine that has never run the CLI would
          be noise, but a CLI that IS installed and unreadable is exactly
          the case the counts above would silently under-report. */}
      {report?.cli && report.cli.databases > 0 ? (
        <p className="mt-2 text-[11px] leading-snug text-kraken-shadow">
          {report.cli.health === "ok"
            ? `+ agy CLI: ${report.cli.events} step${report.cli.events === 1 ? "" : "s"} this week across ${report.cli.conversations} conversation${report.cli.conversations === 1 ? "" : "s"} (not included above).`
            : `⚠ agy CLI store found but unreadable — ${report.cli.reason ?? "unknown reason"}. The counts above exclude it.`}
        </p>
      ) : null}
    </>
  );
}

function GeminiActivityBlock({
  label,
  window,
}: {
  label: string;
  window: GeminiActivityWindow;
}) {
  return (
    <div className="rounded-md border border-kraken-boundless/40 bg-kraken-deep/60 p-3">
      <dt className="text-xs uppercase tracking-wide text-kraken-shadow">
        {label}
      </dt>
      <dd className="mt-1 space-y-0.5 text-xs">
        <div className="flex justify-between gap-2 text-zinc-200">
          <span className="text-kraken-shadow">prompts</span>
          <span className="font-mono">{compact.format(window.userPrompts)}</span>
        </div>
        <div className="flex justify-between gap-2 text-zinc-200">
          <span className="text-kraken-shadow">model turns</span>
          <span className="font-mono">{compact.format(window.modelTurns)}</span>
        </div>
        <div className="flex justify-between gap-2 text-zinc-200">
          <span className="text-kraken-shadow">tool calls</span>
          <span className="font-mono">{compact.format(window.toolCalls)}</span>
        </div>
        <div className="mt-1 flex justify-between gap-2 border-t border-kraken-boundless/30 pt-1 text-zinc-300">
          <span className="text-kraken-shadow">
            {window.conversations} conversation
            {window.conversations === 1 ? "" : "s"}
          </span>
        </div>
      </dd>
    </div>
  );
}

function CodexBudgetCard({
  link,
  budgets,
  loading,
}: {
  link: (typeof PROVIDER_BUDGET_LINKS)[number];
  budgets: ProviderBudgetsResponse | null;
  loading: boolean;
}) {
  const codex = budgets?.codex;
  const hasError = codex !== undefined && "error" in (codex ?? {});
  const report = !hasError && codex ? (codex as CodexUsageReport) : null;
  const hasData = report !== null && report.filesScanned > 0;

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
                : hasData
                  ? `live from ~/.codex/sessions · ${report!.filesScanned} session log${report!.filesScanned === 1 ? "" : "s"} · last turn ${formatLatestTurn(report!.latestTurnAt)}`
                  : `no local sessions yet · ${link.host}`}
          </span>
        </div>
        <a
          href={link.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-[44px] shrink-0 items-center rounded-md border border-kraken-boundless px-3 text-xs font-medium text-kraken-ice transition hover:bg-kraken-boundless/30"
          aria-label={`Open ${link.label} usage page in a new tab`}
        >
          Open ↗
        </a>
      </div>
      {hasData ? (
        <dl className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <CodexUsageWindowBlock
            label="This week (rolling 7d)"
            window={report!.weekly}
          />
          <CodexUsageWindowBlock label="This month" window={report!.monthly} />
        </dl>
      ) : null}
    </>
  );
}

function CodexUsageWindowBlock({
  label,
  window,
}: {
  label: string;
  window: CodexUsageWindow;
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
          <span className="text-kraken-shadow">reasoning</span>
          <span className="font-mono">
            {compact.format(window.reasoningOutputTokens)}
          </span>
        </div>
        <div className="flex justify-between gap-2 text-zinc-200">
          <span className="text-kraken-shadow">cached in</span>
          <span className="font-mono">
            {compact.format(window.cachedInputTokens)}
          </span>
        </div>
        <div className="mt-1 flex justify-between gap-2 border-t border-kraken-boundless/30 pt-1 text-zinc-300">
          <span className="text-kraken-shadow">
            {window.sessions} session{window.sessions === 1 ? "" : "s"}
          </span>
          <span className="font-mono">
            {compact.format(window.turns)} turns
          </span>
        </div>
      </dd>
    </div>
  );
}

// ─── Routing rules section ────────────────────────────────────────────────

const BLANK_FORM = {
  label: "",
  pattern: "",
  patternType: "substring" as "substring" | "regex",
  provider: "claude" as ProviderName,
  model: null as string | null,
  enabled: true,
};

function RoutingRulesSection() {
  const [rules, setRules] = useState<RoutingRule[]>([]);
  const [loadingRules, setLoadingRules] = useState(true);
  const [saving, setSaving] = useState(false);
  const [rulesError, setRulesError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState(BLANK_FORM);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    fetch("/api/routing-rules")
      .then((r) => r.json())
      .then((d: { rules: RoutingRule[] }) => setRules(d.rules ?? []))
      .catch((e: Error) => setRulesError(e.message))
      .finally(() => setLoadingRules(false));
  }, []);

  const saveRules = async (next: RoutingRule[]) => {
    setSaving(true);
    setRulesError(null);
    try {
      const res = await fetch("/api/routing-rules", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rules: next }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to save");
      setRules(data.rules);
      setDirty(false);
    } catch (e) {
      setRulesError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const addRule = async () => {
    if (!form.label.trim() || !form.pattern.trim()) return;
    setSaving(true);
    setRulesError(null);
    try {
      const res = await fetch("/api/routing-rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          model: form.provider === "claude" ? form.model : null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to add");
      setRules(data.rules);
      setForm(BLANK_FORM);
      setShowAdd(false);
    } catch (e) {
      setRulesError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = (id: string) => {
    const next = rules.map((r) =>
      r.id === id ? { ...r, enabled: !r.enabled } : r,
    );
    setRules(next);
    setDirty(true);
  };

  const deleteRule = async (id: string) => {
    setSaving(true);
    setRulesError(null);
    try {
      const res = await fetch(
        `/api/routing-rules?id=${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to delete");
      setRules(data.rules);
      setDirty(false);
    } catch (e) {
      setRulesError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const modelLabel = (model: string | null) => {
    if (!model) return "default";
    return CLAUDE_MODELS.find((m) => m.value === model)?.label ?? model;
  };

  return (
    <div className="rounded-lg border border-kraken-boundless bg-kraken-deep/40 p-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-medium text-zinc-100">Routing rules</h2>
          <p className="mt-0.5 text-xs text-kraken-shadow">
            Rules are evaluated top-to-bottom at dispatch time; first match
            overrides the task&apos;s provider and model.
          </p>
        </div>
        <Link
          href="/analytics"
          className="shrink-0 text-xs text-kraken-ice underline-offset-2 transition hover:underline"
        >
          Analytics ↗
        </Link>
      </div>

      {rulesError ? (
        <p className="mt-2 text-xs text-kraken-alert" role="alert">
          {rulesError}
        </p>
      ) : null}

      {loadingRules ? (
        <p className="mt-3 text-xs text-kraken-shadow">loading…</p>
      ) : (
        <>
          {rules.length > 0 ? (
            <ul className="mt-3 space-y-2">
              {rules.map((rule) => (
                <li
                  key={rule.id}
                  className="flex items-center gap-2 rounded-md border border-kraken-boundless/40 bg-kraken-surface px-3 py-2"
                >
                  <button
                    type="button"
                    onClick={() => toggleEnabled(rule.id)}
                    disabled={saving}
                    className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border text-xs transition ${
                      rule.enabled
                        ? "border-kraken-ice bg-kraken-ice/10 text-kraken-ice"
                        : "border-kraken-boundless bg-transparent text-kraken-shadow"
                    }`}
                    title={rule.enabled ? "Disable rule" : "Enable rule"}
                    aria-label={rule.enabled ? "Disable" : "Enable"}
                  >
                    {rule.enabled ? "✓" : ""}
                  </button>
                  <div className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium text-zinc-200">
                      {rule.label}
                    </span>
                    <span className="block truncate text-[10px] text-kraken-shadow">
                      {rule.patternType === "regex" ? "regex" : "substr"}{" "}
                      <code className="font-mono">{rule.pattern}</code>
                      {" → "}
                      {rule.provider}
                      {rule.model ? ` · ${modelLabel(rule.model)}` : ""}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => void deleteRule(rule.id)}
                    disabled={saving}
                    className="shrink-0 text-xs text-zinc-600 transition hover:text-kraken-alert disabled:opacity-40"
                    aria-label={`Delete rule ${rule.label}`}
                  >
                    🗑️
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-xs text-kraken-shadow">
              No rules yet — all tasks route to their stored provider.
            </p>
          )}

          {dirty ? (
            <button
              type="button"
              onClick={() => void saveRules(rules)}
              disabled={saving}
              className="mt-3 inline-flex tap items-center rounded-md bg-kraken-ice px-3 text-xs font-semibold text-kraken-deep transition hover:brightness-110 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save changes"}
            </button>
          ) : null}

          {!showAdd ? (
            <button
              type="button"
              onClick={() => setShowAdd(true)}
              className="mt-3 inline-flex tap items-center rounded-md border border-kraken-boundless px-3 text-xs font-medium text-zinc-300 transition hover:bg-kraken-boundless/30"
            >
              + Add rule
            </button>
          ) : (
            <div className="mt-3 space-y-2 rounded-md border border-kraken-boundless/60 bg-kraken-surface p-3">
              <label className="block text-xs">
                <span className="text-zinc-400">Label</span>
                <input
                  type="text"
                  value={form.label}
                  onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
                  placeholder="Lint fixes"
                  className="mt-1 block w-full tap rounded-md border border-kraken-boundless bg-kraken-deep px-3 text-xs text-zinc-50 placeholder-zinc-600 focus:border-kraken-ice focus:outline-none"
                />
              </label>
              <label className="block text-xs">
                <span className="text-zinc-400">Pattern</span>
                <input
                  type="text"
                  value={form.pattern}
                  onChange={(e) => setForm((f) => ({ ...f, pattern: e.target.value }))}
                  placeholder="fix lint"
                  className="mt-1 block w-full tap rounded-md border border-kraken-boundless bg-kraken-deep px-3 font-mono text-xs text-zinc-50 placeholder-zinc-600 focus:border-kraken-ice focus:outline-none"
                />
              </label>
              <fieldset className="text-xs">
                <legend className="text-zinc-400">Match type</legend>
                <div className="mt-1 flex gap-3">
                  {(["substring", "regex"] as const).map((pt) => (
                    <label key={pt} className="flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="radio"
                        name="patternType"
                        value={pt}
                        checked={form.patternType === pt}
                        onChange={() => setForm((f) => ({ ...f, patternType: pt }))}
                        className="h-3 w-3 accent-kraken-ice"
                      />
                      <span className="text-zinc-300">{pt}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="flex gap-2">
                <label className="flex-1 text-xs">
                  <span className="text-zinc-400">Provider</span>
                  <select
                    value={form.provider}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        provider: e.target.value as ProviderName,
                        model: null,
                      }))
                    }
                    className="mt-1 block w-full tap rounded-md border border-kraken-boundless bg-kraken-deep px-3 text-xs text-zinc-50 focus:border-kraken-ice focus:outline-none"
                  >
                    <option value="claude">Claude</option>
                    <option value="gemini">Gemini</option>
                  </select>
                </label>
                {form.provider === "claude" ? (
                  <label className="flex-1 text-xs">
                    <span className="text-zinc-400">Model</span>
                    <select
                      value={form.model ?? ""}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, model: e.target.value || null }))
                      }
                      className="mt-1 block w-full tap rounded-md border border-kraken-boundless bg-kraken-deep px-3 text-xs text-zinc-50 focus:border-kraken-ice focus:outline-none"
                    >
                      <option value="">default</option>
                      {CLAUDE_MODELS.map((m) => (
                        <option key={m.value} value={m.value}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
              </div>
              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => { setShowAdd(false); setForm(BLANK_FORM); }}
                  className="flex-1 tap rounded-md border border-kraken-boundless px-3 text-xs font-medium text-zinc-300 transition hover:bg-kraken-boundless/30"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void addRule()}
                  disabled={saving || !form.label.trim() || !form.pattern.trim()}
                  className="flex-1 tap rounded-md bg-kraken-ice px-3 text-xs font-semibold text-kraken-deep transition hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {saving ? "Adding…" : "Add"}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── Main page ─────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const [autoCleanup, setAutoCleanup] = useState(true);
  const [maxConcurrent, setMaxConcurrent] = useState(3);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [budgets, setBudgets] = useState<ProviderBudgetsResponse | null>(null);
  const [budgetsLoading, setBudgetsLoading] = useState(true);
  // Leading-edge throttle gate — first call passes, then closes for 60s.
  // Held in a ref so the same gate survives every re-render of this page
  // (a new gate per render would defeat the throttle entirely).
  const refreshGateRef = useRef(createThrottleGate(60_000));

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/settings");
      const data: SettingsResponse = await res.json();
      if (!res.ok) throw new Error((data as { error?: string }).error ?? "Failed to load");
      setAutoCleanup(Boolean(data.settings.auto_cleanup_worktree));
      if (typeof data.settings.max_concurrent_runs === "number") {
        setMaxConcurrent(data.settings.max_concurrent_runs);
      }
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshBudgets = useCallback(
    async (options: { silent?: boolean } = {}) => {
      // Initial-load fetches flip the loading flag so the card shows
      // "reading session logs…". Interaction-triggered refreshes are
      // silent — data just swaps when it lands, no flicker on every click.
      if (!options.silent) setBudgetsLoading(true);
      try {
        const res = await fetch("/api/provider-budgets");
        const data: ProviderBudgetsResponse = await res.json();
        if (res.ok) setBudgets(data);
      } catch {
        // Falls back to the deep-link-only card layout. No need to surface
        // a banner — the Settings page still works for everything else.
      } finally {
        if (!options.silent) setBudgetsLoading(false);
      }
    },
    [],
  );

  // Single chokepoint for every refresh trigger (mount, click, scroll,
  // tab-becomes-visible). The gate's `check()` returns true at most once
  // per 60s, so the underlying fetch — and the disk read it implies via
  // the API's 60s server cache — is naturally rate-limited.
  const maybeRefreshBudgets = useCallback(
    (silent: boolean) => {
      if (!refreshGateRef.current.check()) return;
      void refreshBudgets({ silent });
    },
    [refreshBudgets],
  );

  useEffect(() => {
    void refresh();
    maybeRefreshBudgets(false);
  }, [refresh, maybeRefreshBudgets]);

  // Refresh the Claude budget on interaction (click/scroll anywhere) and
  // when the tab regains focus, AND on an exponentially-backing-off idle
  // ticker for when the user just leaves the page open. Composition:
  //
  //   - the throttle gate caps *fetch rate* at 1/min (set above)
  //   - the backoff decides *when to try* during stretches of no
  //     interaction: 60s, 120s, 240s, 480s, … 30min cap
  //   - any user activity calls `backoff.resetAndArm()` so the next idle
  //     check is back to the 60s baseline — they're active again
  //
  // A scroll-heavy session triggers the throttle but the backoff keeps
  // re-arming at base. A tab left untouched ramps down naturally so a
  // page open all afternoon doesn't keep hammering disk every minute.
  useEffect(() => {
    const backoff = createIdleBackoff({
      baseMs: IDLE_BACKOFF_BASE_MS,
      maxMs: IDLE_BACKOFF_MAX_MS,
      onFire: () => maybeRefreshBudgets(true),
    });
    backoff.resetAndArm();

    const onInteract = () => {
      maybeRefreshBudgets(true);
      backoff.resetAndArm();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        maybeRefreshBudgets(true);
        backoff.resetAndArm();
      }
    };
    // Capture-phase scroll listener: scroll events don't bubble from
    // inner scrollable elements, so capture catches them all from a
    // single document-level handler.
    document.addEventListener("click", onInteract, { passive: true });
    document.addEventListener("scroll", onInteract, {
      passive: true,
      capture: true,
    });
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      backoff.teardown();
      document.removeEventListener("click", onInteract);
      document.removeEventListener("scroll", onInteract, { capture: true });
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [maybeRefreshBudgets]);

  const handleMaxConcurrent = async (next: number) => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ max_concurrent_runs: next }),
      });
      const data: SettingsResponse = await res.json();
      if (!res.ok) {
        throw new Error(
          (data as { error?: string }).error ?? "Failed to save",
        );
      }
      if (typeof data.settings.max_concurrent_runs === "number") {
        setMaxConcurrent(data.settings.max_concurrent_runs);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

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
          className="tap inline-flex items-center text-xs text-kraken-ice underline-offset-2 transition hover:underline"
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
                {/* The one-liner stays visible; the reasoning you read
                    once and never again goes behind a disclosure. Settings
                    was 1.3 phone-screens of mostly-prose. */}
                <span
                  id="auto-cleanup-help"
                  className="mt-1 block text-xs text-kraken-shadow"
                >
                  Removes the per-task worktree once the agent succeeds.
                </span>
                <InlineDisclosure label="When would I turn this off?">
                  <p>
                    The branch itself always survives, so you can{" "}
                    <code>git checkout</code> the work later either way —
                    cleanup only removes the checked-out directory.
                  </p>
                  <p>
                    Turn it off if you habitually inspect the agent&apos;s
                    changes in the worktree before merging. The gate still has
                    to pass before anything is cleaned up.
                  </p>
                </InlineDisclosure>
                {status ? (
                  <span className="mt-2 block text-xs text-kraken-ice">{status}</span>
                ) : null}
              </span>
            </label>
          </div>

          <div className="rounded-lg border border-kraken-boundless bg-kraken-deep/40 p-4">
            <label className="block">
              <span className="block text-sm font-medium text-zinc-100">
                Max concurrent agent runs
              </span>
              <span className="mt-1 block text-xs text-kraken-shadow">
                Tasks beyond the cap queue and start as slots free up.
              </span>
              <input
                type="number"
                min={1}
                max={10}
                value={maxConcurrent}
                disabled={saving}
                onChange={(e) => {
                  const next = Number.parseInt(e.target.value, 10);
                  if (Number.isFinite(next)) setMaxConcurrent(next);
                }}
                onBlur={() => {
                  const clamped = Math.min(10, Math.max(1, maxConcurrent));
                  setMaxConcurrent(clamped);
                  void handleMaxConcurrent(clamped);
                }}
                className="mt-2 h-11 w-24 rounded-md border border-kraken-boundless bg-kraken-deep px-3 text-sm text-zinc-50 focus:border-kraken-ice focus:outline-none"
              />
            </label>
          </div>

          <div className="rounded-lg border border-kraken-boundless bg-kraken-deep/40 p-4">
            <h2 className="text-sm font-medium text-zinc-100">
              Provider budgets
            </h2>
            <p className="mt-1 text-xs text-kraken-shadow">
              Read from local CLI logs — nothing leaves this Mac.
            </p>
            <FreshnessLine budgets={budgets} loading={budgetsLoading} />
            <InlineDisclosure label="Where do these numbers come from?">
              <p>
                Claude and Codex log every turn&apos;s token counts locally as
                they run, so these are real numbers rather than estimates.
              </p>
              <p>
                Google is different: Antigravity records no token counts
                anywhere on disk, so its card shows{" "}
                <strong className="text-zinc-300">activity</strong> — prompts,
                turns, tool calls — and never pretends to a token figure.
              </p>
              <p>
                A card reading &ldquo;no data yet&rdquo; means that tool has
                not run on this Mac, which is different from having used it
                and spent nothing.
              </p>
            </InlineDisclosure>
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
                if (p.key === "google") {
                  return (
                    <li
                      key={p.key}
                      className="rounded-md border border-kraken-boundless/60 bg-kraken-surface px-3 py-2"
                    >
                      <GoogleBudgetCard
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
                    className="rounded-md border border-kraken-boundless/60 bg-kraken-surface px-3 py-2"
                  >
                    <CodexBudgetCard
                      link={p}
                      budgets={budgets}
                      loading={budgetsLoading}
                    />
                  </li>
                );
              })}
            </ul>
            <SubscriptionEditor />
          </div>

          <BacklogMirror />
        </div>
      )}
    </section>
  );
}
