import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { AgentEvent, AgentRunOptions } from "./types";

/**
 * Default agent timeout. The plan's "key constraint" is 10 minutes — any
 * subprocess that's still alive after that is almost certainly stuck.
 */
export const DEFAULT_AGENT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Spawn a CLI subprocess and yield its line-by-line output as AgentEvents.
 *
 * Shared by all providers: every CLI we wrap (`claude --print`, `gemini -p`,
 * etc.) follows the same shape — text to stdout, errors to stderr, exit code
 * tells you success/failure. Putting the orchestration here means each
 * provider file is just CLI name + argv shape.
 *
 * Guarantees:
 *   - exactly one `exit` event is emitted, last.
 *   - if `signal` aborts or the timeout fires, the subprocess is SIGTERM'd
 *     (then SIGKILL'd after a 2s grace period) and the iterator still ends
 *     cleanly with an `exit` event.
 *   - stdout/stderr are split on newlines so the SSE consumer never has to
 *     deal with partial lines.
 */
export async function* spawnAgent(
  command: string,
  args: readonly string[],
  options: AgentRunOptions,
): AsyncIterable<AgentEvent> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;

  const child = spawn(command, args, {
    cwd: options.cwd,
    // Inherit PATH and HOME so the CLI can find its OAuth session under
    // ~/.claude or ~/.gemini. We intentionally do NOT pass any secrets.
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Buffer events into a queue and have the consumer poll a promise that
  // resolves whenever a new event lands. This lets us forward stdout AND
  // stderr concurrently without losing ordering across the two streams.
  const queue: AgentEvent[] = [];
  let waitForEvent: (() => void) | null = null;

  const pushEvent = (event: AgentEvent): void => {
    queue.push(event);
    if (waitForEvent) {
      const resolve = waitForEvent;
      waitForEvent = null;
      resolve();
    }
  };

  if (child.stdout) {
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => pushEvent({ type: "stdout", data: line }));
  }
  if (child.stderr) {
    const rl = createInterface({ input: child.stderr });
    rl.on("line", (line) => pushEvent({ type: "stderr", data: line }));
  }

  let exitCode: number | null = null;
  let exited = false;
  child.on("exit", (code, signal) => {
    exited = true;
    // node passes `null` for code when the process was killed by a signal.
    // Map "killed by signal" to -1 so consumers have a single sentinel for
    // "non-success without a numeric code." Anything else is the real code.
    exitCode = code ?? (signal ? -1 : 0);
    pushEvent({ type: "exit", data: signal ?? "", code: exitCode });
  });
  child.on("error", (err) => {
    // Spawning failed entirely — emit a single stderr line + exit so the
    // consumer can show "command not found" instead of hanging forever.
    pushEvent({ type: "stderr", data: `spawn failed: ${err.message}` });
    if (!exited) {
      exited = true;
      exitCode = -1;
      pushEvent({ type: "exit", data: "", code: -1 });
    }
  });

  // Timeout + AbortSignal wiring. SIGTERM gives the CLI a chance to clean
  // up; SIGKILL is the safety net for stuck processes.
  const killForReason = (reason: string): void => {
    if (exited) return;
    pushEvent({ type: "stderr", data: `drydock: aborting agent (${reason})` });
    child.kill("SIGTERM");
    setTimeout(() => {
      if (!exited) child.kill("SIGKILL");
    }, 2000).unref();
  };

  const timeoutHandle = setTimeout(() => killForReason("timeout"), timeoutMs);
  timeoutHandle.unref();

  const onAbort = (): void => killForReason("aborted");
  if (options.signal) {
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    // Drain the queue and yield. We exit the loop after the final `exit`
    // event has been yielded, which guarantees the iterator terminates.
    while (true) {
      if (queue.length === 0) {
        if (exited) break;
        await new Promise<void>((resolve) => {
          waitForEvent = resolve;
        });
      }
      const event = queue.shift();
      if (!event) continue;
      yield event;
      if (event.type === "exit") return;
    }
  } finally {
    clearTimeout(timeoutHandle);
    if (options.signal) options.signal.removeEventListener("abort", onAbort);
  }
}
