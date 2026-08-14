/**
 * Types and display constants for the cross-tool session list.
 *
 * Split out from `recent-sessions.ts` because that module imports
 * `node:fs` / `node:os` / `node:path`. A client component that needs the
 * *shape* of a session — or the tool display names — must not drag the
 * filesystem reader into the browser bundle with it. A bare `import type`
 * is erased and would have been safe, but the moment one value (here,
 * `TOOL_LABELS`) is imported alongside, webpack follows the whole module
 * and the build dies on `UnhandledSchemeError: node:fs`.
 *
 * Rule of thumb: anything a `"use client"` file imports as a *value* lives
 * here; anything that touches the disk stays next door.
 */

export type SessionTool = "claude" | "codex" | "antigravity";

export const SESSION_TOOLS: readonly SessionTool[] = [
  "claude",
  "codex",
  "antigravity",
];

/** Display names, so the UI never hard-codes them in three places. */
export const TOOL_LABELS: Record<SessionTool, string> = {
  claude: "Claude Code",
  codex: "Codex",
  antigravity: "Antigravity",
};

export interface RecentSession {
  tool: SessionTool;
  /** The tool's own session id — stable, and what its resume flags take. */
  id: string;
  /** Best available human label. Never empty; falls back to the project. */
  title: string;
  /** The last thing you asked, trimmed. Null when nothing legible. */
  lastPrompt: string | null;
  /** Working directory, worktree collapsed to its parent project. */
  cwd: string | null;
  /** Basename of `cwd` — what the UI actually shows. */
  project: string | null;
  branch: string | null;
  startedAt: string | null;
  endedAt: string;
}

export type ToolHealth = "ok" | "missing" | "error";

export interface ToolStatus {
  tool: SessionTool;
  health: ToolHealth;
  /**
   * Most recent activity of ANY age, from mtimes — so a tool with nothing
   * in the window can still say when it was last used instead of looking
   * like it was never installed.
   */
  lastActiveAt: string | null;
  /** Files actually opened. Makes the number falsifiable. */
  filesRead: number;
  /** Files seen in the window but skipped by the per-tool cap. */
  skipped: number;
  /** Populated only when `health === "error"`. */
  reason: string | null;
}

export interface RecentSessionsResult {
  sessions: RecentSession[];
  tools: ToolStatus[];
  windowDays: number;
}
