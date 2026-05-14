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
