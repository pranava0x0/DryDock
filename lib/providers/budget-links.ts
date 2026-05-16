/**
 * Deep-link targets for the Settings → Provider budgets panel.
 *
 * Phase 1 of DD-BL-22/23: no auth, no API calls — each card just opens the
 * provider's own usage/billing surface in a new tab. The shape carries
 * placeholder fields (`host`) for the eventual credentialed view so the UI
 * can swap in a utilisation bar without re-laying-out the panel.
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
    host: "console.anthropic.com",
    url: "https://console.anthropic.com/settings/usage",
  },
  {
    key: "codex",
    label: "OpenAI Codex",
    host: "platform.openai.com",
    url: "https://platform.openai.com/usage",
  },
  {
    key: "google",
    label: "Google AI Pro",
    host: "gemini.google.com",
    url: "https://gemini.google.com/app",
  },
] as const;
