"use client";

import { useState, type FormEvent } from "react";

/**
 * Token-mode login. The middleware redirects unauthenticated page loads
 * here; a successful POST /api/auth sets the httpOnly cookie and we bounce
 * back to the dashboard. Deliberately minimal — one field, one button,
 * nothing about this page hints at what's behind it.
 */
export default function AuthPage() {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!token || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (res.ok) {
        window.location.href = "/";
        return;
      }
      setError(
        res.status === 401
          ? "That token didn't match."
          : "Login isn't available right now.",
      );
    } catch {
      setError("Couldn't reach the server.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-[80vh] items-center justify-center px-6">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-2xl bg-kraken-surface p-6 ring-1 ring-kraken-boundless/40"
      >
        <h1 className="mb-1 text-lg font-semibold text-kraken-ice">
          ⚓ DryDock
        </h1>
        <p className="mb-4 text-sm text-kraken-shadow">
          Enter the access token to continue.
        </p>
        <input
          type="password"
          autoComplete="current-password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Access token"
          className="mb-3 h-11 w-full rounded-lg bg-kraken-deep px-3 text-sm text-white ring-1 ring-kraken-boundless/50 placeholder:text-kraken-shadow focus:outline-none focus:ring-2 focus:ring-kraken-ice"
        />
        {error && (
          <p className="mb-3 text-sm text-kraken-alert" role="alert">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={!token || submitting}
          className="h-11 w-full rounded-lg bg-kraken-ice font-medium text-kraken-deep transition-opacity disabled:opacity-40"
        >
          {submitting ? "Checking…" : "Unlock"}
        </button>
      </form>
    </main>
  );
}
