/**
 * Parsers for the `claude --print --output-format stream-json --verbose`
 * line protocol. Each subprocess line is one JSON object describing one
 * step of the agent's run. We only need two pieces:
 *
 *  - `assistant` messages → flatten the content blocks to plain text so
 *    the SSE stream renders something the user can read.
 *  - `result` (final) event → carries `usage` (tokens) and `total_cost_usd`.
 *
 * Anything else we ignore — Claude Code adds new event types over time
 * and we don't want a missed-feature flag to break the orchestrator.
 */

export interface ClaudeUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

interface UnknownObject {
  [key: string]: unknown;
}

function isObject(value: unknown): value is UnknownObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Parse one line of stream-json output. Returns one of:
 *   - { kind: "text", data }    a chunk to forward to the user
 *   - { kind: "usage", usage }  the final usage tally
 *   - { kind: "ignored" }       valid JSON but not interesting
 *   - { kind: "garbage", raw }  failed to parse — forward as plain stdout
 */
export type ClaudeLine =
  | { kind: "text"; data: string }
  | { kind: "usage"; usage: ClaudeUsage }
  | { kind: "ignored" }
  | { kind: "garbage"; raw: string };

export function parseClaudeLine(line: string): ClaudeLine {
  if (line.trim() === "") return { kind: "ignored" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { kind: "garbage", raw: line };
  }
  if (!isObject(parsed)) return { kind: "garbage", raw: line };

  const type = parsed.type;

  if (type === "assistant" && isObject(parsed.message)) {
    const message = parsed.message;
    const content = message.content;
    if (Array.isArray(content)) {
      const text = content
        .filter((c): c is UnknownObject => isObject(c) && c.type === "text")
        .map((c) => (typeof c.text === "string" ? c.text : ""))
        .join("");
      if (text.length > 0) return { kind: "text", data: text };
    }
    return { kind: "ignored" };
  }

  if (type === "result") {
    // The `result` event ends the stream. Usage may live at the top level
    // or nested under `message` depending on CLI version, so check both.
    const usageObj = isObject(parsed.usage)
      ? parsed.usage
      : isObject(parsed.message) && isObject(parsed.message.usage)
        ? parsed.message.usage
        : null;
    const inputTokens = usageObj ? asNumber(usageObj.input_tokens) : null;
    const outputTokens = usageObj ? asNumber(usageObj.output_tokens) : null;
    const costUsd =
      asNumber(parsed.total_cost_usd) ?? asNumber(parsed.cost_usd);
    return {
      kind: "usage",
      usage: { inputTokens, outputTokens, costUsd },
    };
  }

  return { kind: "ignored" };
}
