/**
 * Provider names supported by DryDock. Stored in the DB as plain text — keep
 * the union narrow so the DB can be queried against `ProviderName` safely.
 */
export type ProviderName = "claude" | "gemini";

export const PROVIDER_NAMES: readonly ProviderName[] = ["claude", "gemini"] as const;

export function isProviderName(value: unknown): value is ProviderName {
  return value === "claude" || value === "gemini";
}

/**
 * How much blast radius an agent gets, set per project. Maps to explicit
 * CLI permission flags — the host's own `~/.claude/settings.json` should
 * never be the thing deciding what a dispatched agent may do.
 *
 * - `readonly`: plan/analysis only, no writes.
 * - `edits`: file edits plus a narrow Bash allowlist (tests, typecheck,
 *   read-only git). The default.
 * - `full`: file edits plus unrestricted Bash. Still never a permission
 *   bypass — `--dangerously-skip-permissions` is banned on the host.
 */
export type AutonomyLevel = "readonly" | "edits" | "full";

export const AUTONOMY_LEVELS: readonly AutonomyLevel[] = [
  "readonly",
  "edits",
  "full",
] as const;

export function isAutonomyLevel(value: unknown): value is AutonomyLevel {
  return value === "readonly" || value === "edits" || value === "full";
}

/**
 * An event emitted by a running agent. Providers stream these as the
 * subprocess produces output; the orchestrator forwards them to the SSE
 * client and aggregates them into the final `runs.output` row.
 *
 * `exit` is always the last event for a run. `code === 0` means success.
 * `usage` is optional and emitted at most once per run (claude only,
 * currently). It does not terminate the stream — exit still does.
 */
export type AgentEvent =
  | { type: "stdout"; data: string }
  | { type: "stderr"; data: string }
  | { type: "exit"; data: string; code?: number }
  | {
      type: "usage";
      data: string;
      tokensIn: number | null;
      tokensOut: number | null;
      costUsd: number | null;
    };

export interface AgentRunOptions {
  /** Absolute path to the directory the subprocess should run inside. */
  cwd: string;
  /**
   * Hard timeout in milliseconds. If the subprocess hasn't exited by then,
   * the provider must kill it and emit `{ type: 'exit', code: -1 }`.
   */
  timeoutMs?: number;
  /** Abort signal — when triggered, the provider must kill the subprocess. */
  signal?: AbortSignal;
  /**
   * Optional model override. Only honoured by the claude provider today
   * (passed as `--model <model>`). Null / undefined = provider default.
   */
  model?: string | null;
  /**
   * Permission profile for the subprocess. Only honoured by the claude
   * provider today (mapped to `--permission-mode` / `--allowedTools`).
   * Undefined = 'edits'.
   */
  autonomy?: AutonomyLevel;
}

/**
 * The contract every provider must implement. Providers are stateless: each
 * call to `run()` spawns one subprocess. The async iterable yields events as
 * they arrive and ends with a single `exit` event.
 */
export interface AgentProvider {
  name: ProviderName;
  run(prompt: string, options: AgentRunOptions): AsyncIterable<AgentEvent>;
}
