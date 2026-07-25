"use client";

import type { ReactNode } from "react";

/**
 * The house expand/collapse.
 *
 * ── Why native `<details>` and not a useState toggle ────────────────────
 * It is keyboard-operable, screen-reader-announced, and findable by the
 * browser's own in-page search (Chrome and Safari open a closed
 * `<details>` to reveal a match — a React-state toggle hides its content
 * from find-in-page entirely). It also costs no JavaScript, which matters
 * on a phone over a tunnel. The only thing it needs from us is styling
 * and a 44px touch target.
 *
 * ── Why collapse at all ─────────────────────────────────────────────────
 * DryDock is a 375px-first PWA and its dense screens — Analytics → Usage,
 * Settings — had grown to several phone-screens of continuous scroll.
 * Scrolling is the most expensive interaction on a phone held one-handed:
 * it costs attention, loses your place, and buries the one number you
 * opened the app for. Collapsing to a **summary row that still carries
 * the headline figure** means the scan is one screen and the detail is
 * one tap, rather than trading information for brevity.
 *
 * The rule that keeps this honest: a collapsed section must show enough
 * that you never have to open it to know whether you *want* to. A
 * collapsed row reading just "Claude ▸" would force the tap it was
 * supposed to save.
 */
export function Disclosure({
  title,
  summary,
  badge,
  defaultOpen = false,
  accentClass = "text-zinc-100",
  children,
}: {
  /** Left-hand label. Short — this is a scanning surface. */
  title: string;
  /**
   * The headline the collapsed row must carry. Without it the user has
   * to expand just to find out whether expanding is worth it.
   */
  summary?: ReactNode;
  /** Optional status chip rendered before the chevron (health, count). */
  badge?: ReactNode;
  defaultOpen?: boolean;
  /** Provider accent for the title, per design.md's palette table. */
  accentClass?: string;
  children: ReactNode;
}) {
  return (
    <details
      open={defaultOpen}
      className="group rounded-lg border border-kraken-boundless bg-kraken-deep/40 [&_summary::-webkit-details-marker]:hidden"
    >
      {/* Wraps to two lines at 375px rather than truncating the summary.
          The headline figure is the whole reason the collapsed row is
          useful — clipping it to "2.4k…" defeats the pattern. */}
      <summary className="flex min-h-[44px] cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-0.5 px-4 py-2.5 transition hover:bg-kraken-boundless/20">
        <span
          aria-hidden="true"
          // Rotates instead of swapping glyphs so the control reads as one
          // affordance. `motion-reduce` honours design.md's rule.
          className="shrink-0 text-[10px] text-kraken-shadow transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none"
        >
          ▶
        </span>
        <span
          className={`whitespace-nowrap text-sm font-medium ${accentClass}`}
        >
          {title}
        </span>
        {badge ? <span className="shrink-0">{badge}</span> : null}
        {summary ? (
          <span className="ml-auto whitespace-nowrap text-right text-xs text-kraken-shadow">
            {summary}
          </span>
        ) : null}
      </summary>
      <div className="border-t border-kraken-boundless/40 px-4 pb-4 pt-3">
        {children}
      </div>
    </details>
  );
}

/**
 * A quieter inline disclosure for explanatory prose — the "what am I
 * looking at?" affordance. Renders as a link-ish line rather than a
 * panel, so it can sit under a chart without competing with it.
 */
export function InlineDisclosure({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <details className="group mt-2 [&_summary::-webkit-details-marker]:hidden">
      <summary className="inline-flex min-h-[32px] cursor-pointer list-none items-center gap-1 text-[11px] text-kraken-ice underline-offset-2 hover:underline">
        <span
          aria-hidden="true"
          className="text-[9px] transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none"
        >
          ▶
        </span>
        {label}
      </summary>
      <div className="mt-1.5 space-y-1.5 border-l-2 border-kraken-boundless/60 pl-3 text-[11px] leading-relaxed text-kraken-shadow">
        {children}
      </div>
    </details>
  );
}
