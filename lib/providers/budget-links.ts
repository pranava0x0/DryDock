/**
 * Deep-link targets for the Settings → Provider budgets panel.
 *
 * Phase 1 of DD-BL-22/23: no auth, no API calls — each card just opens the
 * provider's own usage/billing surface in a new tab. The shape carries
 * placeholder fields (`host`) for the eventual credentialed view so the UI
 * can swap in a utilisation bar without re-laying-out the panel.
 *
 * **These must point at CONSUMER surfaces, not developer/API consoles**
 * (DD-BL-37). Every one of these originally targeted the API console for
 * its provider, which is a different product from the subscription the
 * cards are actually reporting on: DryDock reads Claude **Max**, ChatGPT
 * **Plus/Codex**, and Google **AI Pro** usage out of local CLI logs, and a
 * per-token API console shows none of that. Landing there reads as "my
 * usage is zero" when the real number is on a page one product over. If
 * you're tempted to swap one of these back to a `platform.*` /
 * `console.*` host, it's the wrong surface — check which plan the card
 * reports on first.
 *
 * Lives in `lib/` (not `app/`) so vitest's include glob picks up the
 * invariant test (`budget-links.test.ts`).
 */
export interface ProviderBudgetLink {
  /** Stable key — used as React list key and for future credential lookup. */
  key: "claude" | "codex" | "google";
  /** User-facing label rendered in the card title. */
  label: string;
  /** Host shown in the subtitle row; must appear in `url`. */
  host: string;
  /** External URL — always opened with `target="_blank" rel="noopener noreferrer"`. */
  url: string;
}

export const PROVIDER_BUDGET_LINKS: readonly ProviderBudgetLink[] = [
  {
    key: "claude",
    label: "Claude Code",
    // Consumer usage for Pro/Max lives on claude.ai. The old target
    // (console.anthropic.com/settings/usage) now redirects to
    // platform.claude.com — the pay-per-token API console, which shows
    // nothing at all for a Max subscription.
    host: "claude.ai",
    url: "https://claude.ai/settings/usage",
  },
  {
    key: "codex",
    label: "OpenAI Codex",
    // Codex usage for a ChatGPT Plus/Pro plan is under chatgpt.com, not
    // platform.openai.com (that's the API dashboard, billed separately).
    host: "chatgpt.com",
    url: "https://chatgpt.com/codex/settings/usage",
  },
  {
    key: "google",
    label: "Google AI Pro",
    // Google publishes no single consumer *usage* URL — gemini.google.com/app
    // is just the chat surface. The plan/billing page is the closest
    // actionable target, which is what the card's "check my plan" intent
    // actually wants.
    host: "one.google.com",
    url: "https://one.google.com/settings",
  },
] as const;
