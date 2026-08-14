"use client";

import type { NextUp, NextUpItem, NextUpKind } from "@/lib/insights/next-up";

/**
 * "Start here" — the ranked recommendation at the very top of the
 * dashboard.
 *
 * Each row shows the *reason* it was ranked, not just the item. A
 * recommendation you can't interrogate is one you stop trusting the first
 * time it's wrong; showing "you were in this 2h ago" or "open PR sitting
 * 9d" lets you overrule it in one glance.
 */

const KIND_STYLES: Record<NextUpKind, { label: string; className: string }> = {
  resume: { label: "resume", className: "bg-emerald-300/15 text-emerald-300" },
  review: { label: "pr", className: "bg-kraken-ice/15 text-kraken-ice" },
  unblock: { label: "blocked", className: "bg-rose-300/15 text-rose-300" },
  issue: { label: "issue", className: "bg-amber-300/15 text-amber-300" },
};

export function NextUpPanel({ nextUp }: { nextUp: NextUp }) {
  const { items, partial, reason } = nextUp;

  return (
    <section className="mb-6">
      <div className="flex items-baseline justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight text-zinc-50">
          Start here
        </h1>
        <span className="text-xs text-kraken-shadow">what to pick up next</span>
      </div>

      {items.length === 0 ? (
        <p className="mt-2 rounded-lg border border-kraken-boundless px-3 py-3 text-sm text-kraken-shadow">
          {partial
            ? // An empty ranking whose inputs failed must not read as
              // "you're all clear".
              (reason ??
              "Could not read your open work, so there is nothing to rank — this is not the same as having nothing to do.")
            : "Nothing queued up. No recent session to resume and no open PRs or issues."}
        </p>
      ) : (
        <ol className="mt-2 space-y-2">
          {items.map((item, i) => (
            <li
              key={item.key}
              className="dd-rise"
              // Capped stagger: three rows at 45ms apart is perceptible as
              // a cascade without making the last row feel late.
              style={{ ["--dd-delay" as string]: `${Math.min(i, 4) * 45}ms` }}
            >
              <NextUpRow item={item} primary={i === 0} />
            </li>
          ))}
        </ol>
      )}

      {items.length > 0 && partial ? (
        <p className="mt-2 text-xs text-kraken-shadow">
          {reason ?? "Some inputs could not be read — this ranking is partial."}
        </p>
      ) : null}
    </section>
  );
}

function NextUpRow({ item, primary }: { item: NextUpItem; primary: boolean }) {
  const kind = KIND_STYLES[item.kind];
  const inner = (
    <>
      <div className="flex items-center gap-2">
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${kind.className}`}
        >
          {kind.label}
        </span>
        {item.project ? (
          <span className="truncate text-xs text-kraken-shadow">{item.project}</span>
        ) : null}
      </div>
      <p
        className={`mt-1 truncate font-medium text-zinc-50 ${primary ? "text-base" : "text-sm"}`}
      >
        {item.title}
      </p>
      <p className="mt-0.5 text-xs text-kraken-ice/80">{item.why}</p>
      {item.context ? (
        <p className="mt-0.5 truncate text-xs text-kraken-shadow">{item.context}</p>
      ) : null}
    </>
  );

  const shell = `block rounded-lg border px-3 py-3 transition ${
    primary
      ? "border-kraken-ice/40 bg-kraken-ice/5"
      : "border-kraken-boundless bg-kraken-deep/40"
  }`;

  // A resume suggestion is a local action with nowhere to navigate — it
  // must not be a link that goes nowhere.
  return item.url === null ? (
    <div className={shell}>{inner}</div>
  ) : (
    <a
      href={item.url}
      target="_blank"
      rel="noopener noreferrer"
      className={`${shell} hover:bg-kraken-boundless/30`}
    >
      {inner}
    </a>
  );
}
