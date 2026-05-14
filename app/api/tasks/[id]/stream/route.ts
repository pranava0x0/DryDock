import type { NextRequest } from "next/server";
import { getTask } from "@/lib/db/tasks";
import { getLatestRunForTask, getRun, type Run } from "@/lib/db/runs";
import {
  getActiveRunController,
} from "@/lib/orchestrator/dispatch";
import { subscribe } from "@/lib/orchestrator/hub";
import { notFound } from "@/lib/api/json";

export const runtime = "nodejs";
// SSE keeps the response open for the duration of the run. Force dynamic so
// Next.js doesn't try to cache or pre-render the route.
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Server-Sent Events stream of agent output for a task's most recent run.
 *
 * The client opens this endpoint with EventSource. Each event becomes one
 * `data:` line of JSON. The connection terminates when the run emits its
 * `exit` event or when the client disconnects.
 *
 * If the run has already finished by the time the client connects, the hub
 * still has the buffered transcript and we replay it. If the hub has been
 * released, we synthesize a single replay event from `runs.output` so the
 * UI still sees something useful.
 */
export async function GET(
  request: NextRequest,
  ctx: RouteContext,
): Promise<Response> {
  const { id } = await ctx.params;
  const task = getTask(id);
  if (!task) return notFound(`Task not found: ${id}`);

  const latestRun = getLatestRunForTask(id);
  if (!latestRun) {
    return notFound(`No runs yet for task: ${id}`);
  }

  // When the client closes the tab / phone, propagate the cancellation down
  // to the subscriber and (if the run is still active) the subprocess.
  const abort = new AbortController();
  request.signal.addEventListener("abort", () => {
    abort.abort();
    const controller = getActiveRunController(latestRun.id);
    if (controller) controller.abort();
  });

  const encoder = new TextEncoder();
  // If the run is already terminal, the hub may or may not still have its
  // history (Next.js HMR can wipe in-memory state in dev). Branching on
  // "currently active" lets us skip subscribing for a run that can never
  // emit again — that path would otherwise hang waiting for events.
  const isActive = getActiveRunController(latestRun.id) !== undefined;
  const stream = new ReadableStream<Uint8Array>({
    async start(streamController) {
      const send = (payload: unknown): void => {
        streamController.enqueue(
          encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
        );
      };

      // Initial "hello" event so the client knows the connection is live
      // even before the agent has produced output.
      streamController.enqueue(
        encoder.encode(
          `event: open\ndata: ${JSON.stringify({ runId: latestRun.id })}\n\n`,
        ),
      );

      try {
        if (isActive) {
          let sawAny = false;
          for await (const event of subscribe(latestRun.id, abort.signal)) {
            sawAny = true;
            send(event);
            if (event.type === "exit") break;
          }
          // Race: the run could have flipped to terminal between the
          // isActive check and the subscribe call. If we still saw nothing,
          // fall through to the replay branch.
          if (!sawAny) replayFromDb(latestRun.id, send);
        } else {
          replayFromDb(latestRun.id, send);
        }
      } finally {
        streamController.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Prevents intermediate proxies (Cloudflare) from buffering the stream.
      "X-Accel-Buffering": "no",
    },
  });
}

/**
 * Replay a terminated run from the database. Used when the in-memory hub
 * no longer has the run's event history (e.g. after a server restart) or
 * when the run was already terminal at connection time.
 *
 * Both `output` and `error` are surfaced — empty stdout is the common case
 * for an immediate spawn failure, and the user needs the stderr text to
 * understand what went wrong.
 */
function replayFromDb(runId: string, send: (payload: unknown) => void): void {
  const run: Run | null = getRun(runId);
  if (!run) return;
  if (run.output && run.output.length > 0) {
    send({ type: "stdout", data: run.output });
  }
  if (run.error && run.error.length > 0) {
    send({ type: "stderr", data: run.error });
  }
  if (run.status !== "running") {
    send({
      type: "exit",
      data: run.status,
      code: run.status === "success" ? 0 : -1,
    });
  }
}
