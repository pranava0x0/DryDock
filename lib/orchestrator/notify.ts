import { getTask } from "../db/tasks";

/**
 * DD-BL-28: outbound webhook on run completion, so the phone hears about a
 * finished agent without the PWA being open (ntfy, Slack/Discord incoming
 * webhook, or any POST-accepting endpoint).
 *
 * Configured by DRYDOCK_NOTIFY_WEBHOOK_URL; unset (the default) makes the
 * whole path a no-op. Fired fire-and-forget from run finalization — a slow
 * or dead endpoint must never delay or fail a run, so this module never
 * throws and the caller never awaits it.
 */

export interface CompletionNotice {
  task_id: string;
  title: string;
  project: string;
  status: "done" | "failed";
  cost_usd: number | null;
  branch: string | null;
}

export type NotifyOutcome = "skipped" | "sent" | "sent-after-retry" | "failed";

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean }>;

/**
 * POST the notice as JSON. One retry on a non-2xx or network error (per the
 * backlog spec), 5s timeout per attempt, and no exception ever escapes.
 */
export async function postCompletionNotice(
  url: string,
  notice: CompletionNotice,
  fetchFn: FetchLike = fetch,
): Promise<NotifyOutcome> {
  const attempt = async (): Promise<boolean> => {
    try {
      const res = await fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(notice),
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  };
  if (await attempt()) return "sent";
  if (await attempt()) return "sent-after-retry";
  return "failed";
}

/**
 * Entry point for the dispatcher: enrich with the task row (title/branch may
 * have changed during the run) and post if a webhook is configured.
 */
export async function notifyRunCompletion(input: {
  taskId: string;
  project: string;
  status: "done" | "failed";
  costUsd: number | null;
}): Promise<NotifyOutcome> {
  const url = process.env.DRYDOCK_NOTIFY_WEBHOOK_URL;
  if (!url) return "skipped";
  try {
    const task = getTask(input.taskId);
    const outcome = await postCompletionNotice(url, {
      task_id: input.taskId,
      title: task?.title ?? "",
      project: input.project,
      status: input.status,
      cost_usd: input.costUsd,
      branch: task?.branch ?? null,
    });
    if (outcome === "failed") {
      console.error(`[drydock] completion webhook failed twice for ${input.taskId}`);
    }
    return outcome;
  } catch (err) {
    // Belt-and-suspenders: nothing from here may reach run finalization.
    console.error("[drydock] completion webhook error:", err);
    return "failed";
  }
}
