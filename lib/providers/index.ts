import type { AgentEvent, AgentProvider, ProviderName } from "./types";
import { claudeProvider } from "./claude";
import { geminiProvider } from "./gemini";

const REGISTRY: Record<ProviderName, AgentProvider> = {
  claude: claudeProvider,
  gemini: geminiProvider,
};

/**
 * Stub provider used by the UAT skill so it can exercise the Run flow
 * without spending API tokens. Activated by setting
 * `DRYDOCK_PROVIDER_STUB=1` in the environment before `npm run dev`.
 * Emits a fixed transcript + usage event and exits cleanly.
 */
function stubProvider(name: ProviderName): AgentProvider {
  return {
    name,
    async *run(prompt: string): AsyncIterable<AgentEvent> {
      yield {
        type: "stdout",
        data: `[drydock-stub] would have dispatched ${name}: ${prompt.slice(0, 80)}`,
      };
      yield {
        type: "usage",
        data: "[drydock-stub] usage — in 0, out 0, $0.0000",
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
      };
      yield { type: "exit", data: "", code: 0 };
    },
  };
}

/**
 * Resolve a provider by name. Throws if the name isn't registered — callers
 * should validate user input with `isProviderName` before reaching here, so
 * a throw means a programmer error (e.g. a DB row with a stale value).
 *
 * When `DRYDOCK_PROVIDER_STUB=1` is set, every name resolves to a no-op
 * stub. This is for the UAT skill — never set it in production.
 */
export function getProvider(name: ProviderName): AgentProvider {
  if (process.env.DRYDOCK_PROVIDER_STUB === "1") {
    return stubProvider(name);
  }
  const provider = REGISTRY[name];
  if (!provider) {
    throw new Error(`Unknown provider: ${name}`);
  }
  return provider;
}

export { claudeProvider, geminiProvider };
export type { AgentProvider, ProviderName, AgentEvent } from "./types";
export { isProviderName, PROVIDER_NAMES } from "./types";
