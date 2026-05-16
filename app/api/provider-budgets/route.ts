import { NextResponse } from "next/server";
import { readClaudeUsage, type ClaudeUsageReport } from "@/lib/providers/claude-usage";

export const runtime = "nodejs";

/**
 * GET /api/provider-budgets
 *
 * Returns aggregated usage signals per provider. Today only Claude has a
 * data path (local session jsonls); OpenAI Codex (ChatGPT) and Google AI
 * Pro (gemini.google.com) are subscription-only with no public usage API
 * and no local logs, so they always return `null` here — the UI falls
 * back to the deep-link card for those.
 *
 * Cached in-process for 60 seconds — aligned with the Settings page's
 * client-side throttle gate (interactions can only trigger a refresh once
 * per minute). Reading ~128 jsonl files takes ~800ms on a warm SSD; this
 * keeps disk reads off the hot path of every click/scroll while never
 * letting the displayed numbers be more than ~60s behind.
 */

const CACHE_TTL_MS = 60 * 1000;

let cache: { at: number; data: ProviderBudgetsResponse } | null = null;

interface ProviderBudgetsResponse {
  claude: ClaudeUsageReport | { error: string };
  codex: null;
  google: null;
  cachedAt: string;
}

export async function GET() {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) {
    return NextResponse.json(cache.data);
  }

  let claude: ClaudeUsageReport | { error: string };
  try {
    claude = await readClaudeUsage();
  } catch (err) {
    // readClaudeUsage already swallows the common case (no ~/.claude/
    // projects yet). This catches genuine surprises — surface the error
    // message rather than 500ing, so the UI degrades to deep-link.
    claude = { error: (err as Error).message ?? "Failed to read Claude usage" };
  }

  const response: ProviderBudgetsResponse = {
    claude,
    codex: null,
    google: null,
    cachedAt: new Date().toISOString(),
  };
  cache = { at: now, data: response };
  return NextResponse.json(response);
}
