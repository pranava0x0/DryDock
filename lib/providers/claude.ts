import type {
  AgentEvent,
  AgentProvider,
  AgentRunOptions,
} from "./types";
import { spawnAgent } from "./spawn";
import { parseClaudeLine } from "./claude-parse";

/**
 * Claude Code CLI provider.
 *
 * Phase 3: uses `--output-format stream-json --verbose` so we can capture
 * usage (tokens + cost) from the final `result` event. Each stdout line
 * from the CLI is one JSON object; we forward visible text to the SSE
 * client as `stdout` events and emit a single `usage` event before exit.
 *
 * Auth: CLI's own OAuth session under `~/.claude/` — no API key.
 */
export const claudeProvider: AgentProvider = {
  name: "claude",
  run(prompt: string, options: AgentRunOptions): AsyncIterable<AgentEvent> {
    const raw = spawnAgent(
      "claude",
      ["--print", "--output-format", "stream-json", "--verbose", prompt],
      options,
    );
    return transformClaudeStream(raw);
  },
};

/**
 * Transform the CLI's JSON-per-line stdout into the AgentEvent shape the
 * rest of DryDock expects. Stderr / exit events pass through unchanged so
 * spawn-level failures (binary missing, signals) keep their semantics.
 *
 * If a stdout line isn't JSON (e.g. the CLI printed a deprecation warning
 * before the JSON stream started), we forward it as a raw stdout line so
 * the user sees it instead of silently dropping it.
 */
async function* transformClaudeStream(
  source: AsyncIterable<AgentEvent>,
): AsyncIterable<AgentEvent> {
  let lastUsage: AgentEvent | null = null;

  for await (const event of source) {
    if (event.type !== "stdout") {
      yield event;
      continue;
    }
    const parsed = parseClaudeLine(event.data);
    switch (parsed.kind) {
      case "text":
        yield { type: "stdout", data: parsed.data };
        break;
      case "usage":
        lastUsage = {
          type: "usage",
          data: formatUsageSummary(parsed.usage),
          tokensIn: parsed.usage.inputTokens,
          tokensOut: parsed.usage.outputTokens,
          costUsd: parsed.usage.costUsd,
        };
        // Emit a visible summary line so it shows up in the live transcript
        // too. The dispatcher reads the structured fields for persistence.
        yield lastUsage;
        break;
      case "garbage":
        yield { type: "stdout", data: parsed.raw };
        break;
      case "ignored":
        // intentionally drop
        break;
    }
  }
}

function formatUsageSummary(usage: {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}): string {
  const parts: string[] = [];
  if (usage.inputTokens !== null) parts.push(`in ${usage.inputTokens}`);
  if (usage.outputTokens !== null) parts.push(`out ${usage.outputTokens}`);
  if (usage.costUsd !== null) parts.push(`$${usage.costUsd.toFixed(4)}`);
  return `[drydock] usage — ${parts.join(", ") || "no data"}`;
}
