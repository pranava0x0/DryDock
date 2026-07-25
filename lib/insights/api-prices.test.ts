import { describe, expect, it } from "vitest";
import { estimateApiValue, priceFor } from "./api-prices";

describe("priceFor", () => {
  it("matches by longest prefix so dated suffixes resolve", () => {
    expect(priceFor("claude-haiku-4-5-20251001")).not.toBeNull();
    expect(priceFor("claude-sonnet")!.inputPerMTok).toBe(3);
  });

  it("is case-insensitive", () => {
    expect(priceFor("Claude-Opus-4")!.outputPerMTok).toBe(75);
  });

  it("returns null for an unpriced model rather than a nearby guess", () => {
    // claude-fable-5 dominates this user's logs and has no published
    // list price. Returning a "close enough" number here would make the
    // headline estimate look authoritative while being invented.
    expect(priceFor("claude-fable-5")).toBeNull();
    expect(priceFor("gpt-5.6-sol")).toBeNull();
    expect(priceFor("")).toBeNull();
  });
});

describe("estimateApiValue", () => {
  it("prices input, output, and cache reads at their own rates", () => {
    // Cache reads are ~10x cheaper than input. Charging them at the
    // input rate would badly overstate a Claude Code day, where cache
    // reads dominate the token counts.
    const est = estimateApiValue([
      {
        model: "claude-sonnet",
        input_tokens: 1_000_000,
        cached_tokens: 1_000_000,
        output_tokens: 1_000_000,
      },
    ]);
    expect(est.usd).toBeCloseTo(3 + 0.3 + 15, 2);
    expect(est.coverage).toBe(1);
  });

  it("excludes unpriced models and reports the coverage gap", () => {
    const est = estimateApiValue([
      {
        model: "claude-sonnet",
        input_tokens: 1_000_000,
        cached_tokens: 0,
        output_tokens: 0,
      },
      {
        model: "claude-fable-5",
        input_tokens: 3_000_000,
        cached_tokens: 0,
        output_tokens: 0,
      },
    ]);
    expect(est.usd).toBeCloseTo(3, 2);
    expect(est.pricedTokens).toBe(1_000_000);
    expect(est.unpricedTokens).toBe(3_000_000);
    expect(est.coverage).toBeCloseTo(0.25, 5);
  });

  it("reports full coverage and zero dollars for no data", () => {
    const est = estimateApiValue([]);
    expect(est.usd).toBe(0);
    expect(est.coverage).toBe(1);
  });

  it("treats an unknown model as entirely unpriced, not free", () => {
    // The failure to avoid: an unknown model silently contributing $0 at
    // full coverage would read as "this usage was worthless".
    const est = estimateApiValue([
      {
        model: "",
        input_tokens: 500,
        cached_tokens: 0,
        output_tokens: 500,
      },
    ]);
    expect(est.usd).toBe(0);
    expect(est.coverage).toBe(0);
    expect(est.unpricedTokens).toBe(1000);
  });

  it("ignores negative token counts rather than crediting dollars back", () => {
    const est = estimateApiValue([
      {
        model: "claude-sonnet",
        input_tokens: -1_000_000,
        cached_tokens: 0,
        output_tokens: 1_000_000,
      },
    ]);
    expect(est.usd).toBeCloseTo(15, 2);
  });
});
