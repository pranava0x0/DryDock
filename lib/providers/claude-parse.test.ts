import { describe, it, expect } from "vitest";
import { parseClaudeLine } from "./claude-parse";

describe("parseClaudeLine", () => {
  it("ignores blank lines", () => {
    expect(parseClaudeLine("")).toEqual({ kind: "ignored" });
    expect(parseClaudeLine("   ")).toEqual({ kind: "ignored" });
  });

  it("treats non-JSON as garbage so the user still sees it", () => {
    const out = parseClaudeLine("warning: deprecated flag");
    expect(out).toEqual({ kind: "garbage", raw: "warning: deprecated flag" });
  });

  it("flattens assistant text content into a text event", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Hello " },
          { type: "text", text: "world" },
        ],
      },
    });
    expect(parseClaudeLine(line)).toEqual({
      kind: "text",
      data: "Hello world",
    });
  });

  it("ignores assistant events with no text blocks", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Read" }],
      },
    });
    expect(parseClaudeLine(line)).toEqual({ kind: "ignored" });
  });

  it("extracts usage and cost from the result event (top-level usage)", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      total_cost_usd: 0.0123,
      usage: { input_tokens: 1234, output_tokens: 567 },
    });
    expect(parseClaudeLine(line)).toEqual({
      kind: "usage",
      usage: { inputTokens: 1234, outputTokens: 567, costUsd: 0.0123 },
    });
  });

  it("extracts usage from message.usage when top-level usage is missing", () => {
    const line = JSON.stringify({
      type: "result",
      message: { usage: { input_tokens: 10, output_tokens: 20 } },
    });
    const out = parseClaudeLine(line);
    if (out.kind !== "usage") throw new Error("expected usage");
    expect(out.usage.inputTokens).toBe(10);
    expect(out.usage.outputTokens).toBe(20);
    expect(out.usage.costUsd).toBeNull();
  });

  it("falls back to cost_usd when total_cost_usd is absent", () => {
    const line = JSON.stringify({
      type: "result",
      cost_usd: 0.5,
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    const out = parseClaudeLine(line);
    if (out.kind !== "usage") throw new Error("expected usage");
    expect(out.usage.costUsd).toBe(0.5);
  });

  it("ignores unknown event types", () => {
    const line = JSON.stringify({ type: "system", subtype: "init" });
    expect(parseClaudeLine(line)).toEqual({ kind: "ignored" });
  });

  it("treats arrays / null as garbage", () => {
    expect(parseClaudeLine("[1,2,3]").kind).toBe("garbage");
    expect(parseClaudeLine("null").kind).toBe("garbage");
  });
});
