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
