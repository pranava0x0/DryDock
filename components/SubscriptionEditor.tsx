"use client";

import { useEffect, useState } from "react";

/**
 * Subscription registry editor (EP-10 Spec C).
 *
 * Three rows, typed once, ~60 seconds — the only 100%-reliable source for
 * what each plan costs. Everything the Usage tab says about "is this plan
 * worth it" hangs off these numbers, so the UX target is: three fields,
 * one save, never asked again.
 *
 * Deliberately not a modal. Editing lives inline under the provider
 * budget cards it annotates, because the question "what does this cost?"
 * arises exactly while looking at that card.
 */

type ProviderKey = "claude" | "codex" | "google";

interface Subscription {
  provider: ProviderKey;
  plan_name: string | null;
  price_usd_month: number | null;
  renewal_day: number | null;
  cap_notes: string | null;
  source: string;
}

const PROVIDERS: Array<{ key: ProviderKey; label: string; example: string }> = [
  { key: "claude", label: "Claude", example: "Max 20x" },
  { key: "codex", label: "OpenAI Codex", example: "ChatGPT Plus" },
  { key: "google", label: "Google AI", example: "AI Pro" },
];

export function SubscriptionEditor() {
  const [subs, setSubs] = useState<Record<string, Subscription>>({});
  const [editing, setEditing] = useState<ProviderKey | null>(null);
  const [plan, setPlan] = useState("");
  const [price, setPrice] = useState("");
  const [renewal, setRenewal] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    try {
      const res = await fetch("/api/subscriptions");
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to load");
      const map: Record<string, Subscription> = {};
      for (const sub of body.subscriptions as Subscription[]) {
        map[sub.provider] = sub;
      }
      setSubs(map);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const startEdit = (key: ProviderKey): void => {
    const existing = subs[key];
    setEditing(key);
    setPlan(existing?.plan_name ?? "");
    setPrice(
      existing?.price_usd_month !== null && existing?.price_usd_month !== undefined
        ? String(existing.price_usd_month)
        : "",
    );
    setRenewal(
      existing?.renewal_day !== null && existing?.renewal_day !== undefined
        ? String(existing.renewal_day)
        : "",
    );
  };

  const save = async (key: ProviderKey): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      // Empty input means "clear this field", which is why each value is
      // sent as an explicit null rather than being omitted — omission
      // means "leave unchanged" on the server.
      const res = await fetch("/api/subscriptions", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: key,
          plan_name: plan.trim() === "" ? null : plan.trim(),
          price_usd_month: price.trim() === "" ? null : Number(price),
          renewal_day: renewal.trim() === "" ? null : Number(renewal),
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "Save failed");
        return;
      }
      setEditing(null);
      await refresh();
    } catch (err) {
      // A dropped connection, a non-JSON response, or an aborted request
      // all land here. Without this the click handler's discarded promise
      // turned the failure into an unhandled rejection: the sheet stayed
      // open, nothing was shown, and the user had no way to tell the save
      // hadn't happened (Codex, PR #8).
      setError((err as Error).message || "Save failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 border-t border-kraken-boundless/40 pt-3">
      <h3 className="text-xs font-medium uppercase tracking-wide text-kraken-shadow">
        Subscriptions
      </h3>
      <p className="mt-1 text-[11px] leading-snug text-kraken-shadow">
        What each plan costs, so Analytics → Usage can put your usage next to
        it. Typed once — no provider exposes this to a consumer account, so
        it can&apos;t be read automatically.
      </p>
      {error ? (
        <p role="alert" className="mt-2 text-[11px] text-kraken-alert">
          {error}
        </p>
      ) : null}

      <ul className="mt-2 space-y-1.5">
        {PROVIDERS.map(({ key, label, example }) => {
          const sub = subs[key];
          const isEditing = editing === key;
          return (
            <li key={key} className="text-xs">
              {isEditing ? (
                <div className="rounded-md border border-kraken-ice/40 bg-kraken-deep p-2">
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <input
                      type="text"
                      value={plan}
                      onChange={(e) => setPlan(e.target.value)}
                      placeholder={example}
                      aria-label={`${label} plan name`}
                      className="min-h-[44px] flex-1 rounded-md border border-kraken-boundless bg-kraken-deep px-2 text-xs text-zinc-50 placeholder-zinc-600 focus:border-kraken-ice focus:outline-none"
                    />
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      value={price}
                      onChange={(e) => setPrice(e.target.value)}
                      placeholder="$/mo"
                      aria-label={`${label} monthly price`}
                      className="min-h-[44px] w-full rounded-md border border-kraken-boundless bg-kraken-deep px-2 text-xs text-zinc-50 placeholder-zinc-600 focus:border-kraken-ice focus:outline-none sm:w-24"
                    />
                    <input
                      type="number"
                      min={1}
                      max={31}
                      value={renewal}
                      onChange={(e) => setRenewal(e.target.value)}
                      placeholder="day"
                      aria-label={`${label} renewal day of month`}
                      className="min-h-[44px] w-full rounded-md border border-kraken-boundless bg-kraken-deep px-2 text-xs text-zinc-50 placeholder-zinc-600 focus:border-kraken-ice focus:outline-none sm:w-20"
                    />
                  </div>
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      onClick={() => void save(key)}
                      disabled={busy}
                      className="tap rounded-md bg-kraken-ice px-3 text-xs font-semibold text-kraken-deep transition hover:brightness-110 disabled:opacity-50"
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditing(null)}
                      disabled={busy}
                      className="tap rounded-md border border-kraken-boundless px-3 text-xs text-zinc-300 transition hover:bg-kraken-boundless/30"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-between gap-2 rounded-md px-1 py-1">
                  <span className="min-w-0 truncate text-zinc-300">
                    <span className="text-kraken-shadow">{label}:</span>{" "}
                    {sub?.plan_name ?? "not set"}
                    {sub?.price_usd_month !== null &&
                    sub?.price_usd_month !== undefined
                      ? ` · $${sub.price_usd_month}/mo`
                      : ""}
                    {sub?.renewal_day ? ` · renews ${sub.renewal_day}th` : ""}
                  </span>
                  <button
                    type="button"
                    onClick={() => startEdit(key)}
                    aria-label={`Edit ${label} subscription`}
                    className="tap shrink-0 rounded-md border border-kraken-boundless px-2 text-xs text-zinc-300 transition hover:bg-kraken-boundless/30"
                  >
                    ✏️
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
