import type { Task } from "../db/tasks";

/**
 * Build the prompt passed to the agent CLI.
 *
 * Kept as a pure function so it can be unit-tested without spawning anything.
 * The format is deliberately plain: the agent CLIs already know how to be
 * agents — DryDock just needs to hand them a task description that won't
 * confuse them.
 */
export function buildAgentPrompt(task: Pick<Task, "title" | "description">): string {
  const title = task.title.trim();
  const description = task.description.trim();
  if (!description) return title;
  return `${title}\n\n${description}`;
}

/**
 * Build the prompt for a follow-up turn — just the user's feedback, since a
 * `--resume`d session already carries the full prior context. Trimmed; the
 * caller guarantees it's non-empty.
 *
 * The no-session fallback (a failed run that can't resume) takes a different
 * path: the follow-up route folds the feedback into the task description, so
 * buildAgentPrompt picks it up on the fresh run without a separate builder.
 */
export function buildFollowupPrompt(feedback: string): string {
  return feedback.trim();
}

/**
 * Upper bound on a session-kickoff prompt. Generous (a long pasted spec
 * fits) while still bounding what an authenticated-but-hostile caller can
 * make the server store and hand to a subprocess argv.
 */
export const SESSION_PROMPT_MAX_CHARS = 20_000;

/**
 * Derive a task title from a free-form session prompt so the composer can
 * be a single textarea. First non-empty line, internal whitespace
 * collapsed, truncated with an ellipsis — the title feeds the branch slug
 * and every list UI, so it must stay short and single-line.
 */
export function synthesizeSessionTitle(prompt: string, max = 60): string {
  const firstLine =
    prompt
      .split("\n")
      .map((line) => line.replace(/\s+/g, " ").trim())
      .find((line) => line.length > 0) ?? "";
  if (firstLine.length <= max) return firstLine;
  return `${firstLine.slice(0, max - 1).trimEnd()}…`;
}
