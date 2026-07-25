/**
 * API list prices, for the "what would this usage have cost at API
 * rates?" framing (EP-10 Spec A).
 *
 * ── Why this is NOT called spend ────────────────────────────────────────
 * All three subscriptions are flat-rate. Multiplying tokens by an API
 * price and labelling the result "spend" would be a confident wrong
 * value: the user did not pay it and never will. What the number IS good
 * for is the question they actually asked — "is this plan earning its
 * keep?" — so it is always rendered as *API-equivalent value*, beside the
 * flat monthly price, explicitly as an estimate. The only figure DryDock
 * calls "cost" is `runs.cost_usd`, which the provider itself reported.
 *
 * ── Unknown models are unpriced, not guessed ────────────────────────────
 * This table only carries prices that were published. A model that isn't
 * in it contributes zero dollars AND is counted in `unpricedTokens`, so
 * every estimate can be rendered with its own coverage figure ("priced
 * 82% of tokens"). Filling the gap with a nearby model's price would
 * silently move the number by an unknown amount — which is exactly the
 * kind of plausible-looking wrongness that is worse than a blank.
 *
 * Prices are per **million tokens**, USD. They go stale; `PRICES_AS_OF`
 * is rendered next to any estimate so a reader can see how old the
 * assumption is, and updating this file is the whole maintenance story.
 */

export const PRICES_AS_OF = "2026-05";

export interface ModelPrice {
  /** USD per million input tokens. */
  inputPerMTok: number;
  /** USD per million output tokens. */
  outputPerMTok: number;
  /**
   * USD per million cache-read tokens. Cache reads are billed at a deep
   * discount, so folding them in at the input rate would overstate a
   * Claude Code day badly — cache reads dominate its token counts.
   */
  cacheReadPerMTok: number;
}

/**
 * Matched by longest-prefix against the model id recorded in the logs
 * (`claude-fable-5`, `gpt-5.6-sol`, …), so a dated suffix like
 * `-20251001` doesn't need its own entry.
 */
const PRICES: ReadonlyArray<readonly [string, ModelPrice]> = [
  [
    "claude-opus",
    { inputPerMTok: 15, outputPerMTok: 75, cacheReadPerMTok: 1.5 },
  ],
  [
    "claude-sonnet",
    { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3 },
  ],
  [
    "claude-haiku",
    { inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1 },
  ],
] as const;

/**
 * Deliberately absent, and it matters: `claude-fable-5` is the model that
 * dominates this user's logs, and no list price for it was verifiable
 * when this was written. Adding a plausible number would make the
 * headline estimate look authoritative while being made up. Instead its
 * tokens land in `unpricedTokens` and the UI shows the coverage gap. Add
 * the entry above once the real price is known — that is the only change
 * needed.
 */
export const KNOWN_UNPRICED_NOTE =
  "Some models have no published list price yet; their tokens are excluded from the estimate.";

export function priceFor(model: string): ModelPrice | null {
  if (typeof model !== "string" || model.length === 0) return null;
  const id = model.toLowerCase();
  let best: ModelPrice | null = null;
  let bestLen = 0;
  for (const [prefix, price] of PRICES) {
    if (id.startsWith(prefix) && prefix.length > bestLen) {
      best = price;
      bestLen = prefix.length;
    }
  }
  return best;
}

export interface TokenBundle {
  model: string;
  input_tokens: number;
  cached_tokens: number;
  output_tokens: number;
}

export interface ValueEstimate {
  /** USD the priced portion would have cost at API list rates. */
  usd: number;
  /** Tokens that contributed to `usd`. */
  pricedTokens: number;
  /** Tokens skipped because their model has no published price. */
  unpricedTokens: number;
  /** pricedTokens / (priced + unpriced), 0–1. 1 when there are no tokens. */
  coverage: number;
  asOf: string;
}

/**
 * Estimate what a set of token bundles would have cost at API list
 * prices. Never throws and never guesses: an unknown model adds to
 * `unpricedTokens` and drags `coverage` down, which is the signal the UI
 * renders beside the dollar figure.
 */
export function estimateApiValue(bundles: TokenBundle[]): ValueEstimate {
  let usd = 0;
  let priced = 0;
  let unpriced = 0;

  for (const b of bundles) {
    const total =
      Math.max(0, b.input_tokens) +
      Math.max(0, b.cached_tokens) +
      Math.max(0, b.output_tokens);
    const price = priceFor(b.model);
    if (!price) {
      unpriced += total;
      continue;
    }
    priced += total;
    usd +=
      (Math.max(0, b.input_tokens) / 1_000_000) * price.inputPerMTok +
      (Math.max(0, b.cached_tokens) / 1_000_000) * price.cacheReadPerMTok +
      (Math.max(0, b.output_tokens) / 1_000_000) * price.outputPerMTok;
  }

  const all = priced + unpriced;
  return {
    usd: Math.round(usd * 100) / 100,
    pricedTokens: priced,
    unpricedTokens: unpriced,
    coverage: all === 0 ? 1 : priced / all,
    asOf: PRICES_AS_OF,
  };
}
