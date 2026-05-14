"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

interface SettingsResponse {
  settings: {
    auto_cleanup_worktree?: boolean;
  };
}

export default function SettingsPage() {
  const [autoCleanup, setAutoCleanup] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

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

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
      )}
    </section>
  );
}
