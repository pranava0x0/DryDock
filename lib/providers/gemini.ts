import type { AgentProvider, AgentRunOptions } from "./types";
import { spawnAgent } from "./spawn";

/**
 * Gemini CLI provider.
 *
 * Shells out to `gemini -p "<prompt>"` in the project directory. Auth comes
 * from the Google OAuth session at `~/.gemini/` — no API key in the repo.
 */
export const geminiProvider: AgentProvider = {
  name: "gemini",
  run(prompt: string, options: AgentRunOptions) {
    return spawnAgent("gemini", ["-p", prompt], options);
  },
};
