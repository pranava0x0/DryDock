import { NextResponse } from "next/server";
import { readClaudeUsage, type ClaudeUsageReport } from "@/lib/providers/claude-usage";
import { readGeminiUsage, type GeminiUsageReport } from "@/lib/providers/gemini-usage";
import { readCodexUsage, type CodexUsageReport } from "@/lib/providers/codex-usage";

export const runtime = "nodejs";

/**
 * GET /api/provider-budgets
 *
 * Returns aggregated usage signals per provider:
 *   - claude: token usage from local Claude Code session jsonls.
 *   - codex: token usage from local OpenAI Codex CLI rollout jsonls
 *     (~/.codex/sessions). Zeros until the Codex CLI has been run locally.
 *   - google: activity counts (not tokens) from local Google Antigravity
 *     step logs — Google AI Pro / Gemini have no public usage API and
 *     Antigravity records no token counts, so this is the only local
 *     signal available.
 *
 * Each reader degrades to zeros when its tool has never run locally, so a
 * card shows "no data yet" rather than erroring.
 *
 * Cached in-process for 60 seconds — aligned with the Settings page's
 * client-side throttle gate (interactions can only trigger a refresh once
 * per minute). Reading the local logs takes up to ~1s on a warm SSD; this
 * keeps disk reads off the hot path of every click/scroll while never
 * letting the displayed numbers be more than ~60s behind.
 */

const CACHE_TTL_MS = 60 * 1000;

let cache: { at: number; data: ProviderBudgetsResponse } | null = null;

interface ProviderBudgetsResponse {
  claude: ClaudeUsageReport | { error: string };
  codex: CodexUsageReport | { error: string };
  google: GeminiUsageReport | { error: string };
  cachedAt: string;
}

export async function GET() {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) {
    return NextResponse.json(cache.data);
  }

  // Read all providers concurrently — each swallows its own common
  // empty-state case (no ~/.claude, ~/.codex, or ~/.gemini yet) and
  // returns zeros.
  const [claude, codex, google] = await Promise.all([
    readClaudeUsage().catch(
      (err): { error: string } => ({
        // Genuine surprises only — surface the message rather than 500ing,
        // so the UI degrades to the deep-link card.
        error: (err as Error).message ?? "Failed to read Claude usage",
      }),
    ),
    readCodexUsage().catch(
      (err): { error: string } => ({
        error: (err as Error).message ?? "Failed to read Codex usage",
      }),
    ),
    readGeminiUsage().catch(
      (err): { error: string } => ({
        error: (err as Error).message ?? "Failed to read Google activity",
      }),
    ),
  ]);

  const response: ProviderBudgetsResponse = {
    claude,
    codex,
    google,
    cachedAt: new Date().toISOString(),
  };
  cache = { at: now, data: response };
  return NextResponse.json(response);
}
