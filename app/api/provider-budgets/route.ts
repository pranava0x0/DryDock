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
 * ## Why this is stale-while-revalidate rather than a plain TTL cache
 *
 * Reading the logs is genuinely expensive: measured at ~25s cold on this
 * machine (~900 session logs, most of them skipped by the mtime pre-filter
 * but the survivors still streaming line-by-line). An earlier comment here
 * claimed "~1s on a warm SSD" — off by 25x, and nothing surfaced that.
 *
 * With a plain 60s TTL, one unlucky request per minute paid the whole ~25s,
 * and the Settings page polls. So the panel was reliably unusable rather
 * than occasionally slow.
 *
 * Now: a cached payload is served *immediately*, however stale, and the
 * refresh runs in the background. Only the very first read after a server
 * start can block, because there is genuinely nothing to show yet. The
 * response carries `cachedAt` and `refreshing` so the UI can say how old
 * the numbers are instead of implying they're live.
 */

const CACHE_TTL_MS = 60 * 1000;

let cache: { at: number; data: ProviderBudgetsResponse } | null = null;
/** De-dupes concurrent refreshes — the scan is far too costly to run twice. */
let inFlight: Promise<ProviderBudgetsResponse> | null = null;

interface ProviderBudgetsResponse {
  claude: ClaudeUsageReport | { error: string };
  codex: CodexUsageReport | { error: string };
  google: GeminiUsageReport | { error: string };
  cachedAt: string;
  /** True when the numbers came from cache and a refresh is running behind it. */
  refreshing?: boolean;
}

async function readAll(): Promise<ProviderBudgetsResponse> {
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

  return { claude, codex, google, cachedAt: new Date().toISOString() };
}

/** Start a refresh unless one is already running. Never rejects to the caller. */
function refresh(): Promise<ProviderBudgetsResponse> {
  if (inFlight) return inFlight;
  inFlight = readAll()
    .then((data) => {
      cache = { at: Date.now(), data };
      return data;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export async function GET() {
  const now = Date.now();

  if (cache) {
    const stale = now - cache.at >= CACHE_TTL_MS;
    if (stale) {
      // Fire and forget: the point is that nobody waits for this. A failure
      // leaves the previous payload in place, which is the right fallback —
      // but it must not surface as an unhandled rejection.
      void refresh().catch(() => {});
    }
    return NextResponse.json({
      ...cache.data,
      refreshing: stale || inFlight !== null,
    });
  }

  // Cold start: nothing cached, so there is genuinely nothing to serve but
  // the real read.
  const data = await refresh();
  return NextResponse.json({ ...data, refreshing: false });
}
