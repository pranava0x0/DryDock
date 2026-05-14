import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { spawnAgent } from "./spawn";
import type { AgentEvent } from "./types";

async function collect(
  iter: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

/**
 * Narrow the last event to the `exit` variant so we can assert on its
 * `code` field. Throws (failing the test) if the event isn't an exit.
 */
function expectExit(events: AgentEvent[]): {
  type: "exit";
  data: string;
  code?: number;
} {
  const last = events.at(-1);
  if (!last) throw new Error("no events");
  if (last.type !== "exit") {
    throw new Error(`expected exit, got ${last.type}`);
  }
  return last;
}

describe("spawnAgent", () => {
  it("yields stdout lines then an exit event", async () => {
    const events = await collect(
      spawnAgent(
        process.execPath, // node
        ["-e", "console.log('one');console.log('two');"],
        { cwd: tmpdir() },
      ),
    );
    expect(events.filter((e) => e.type === "stdout").map((e) => e.data)).toEqual(
      ["one", "two"],
    );
    const exit = expectExit(events);
    expect(exit.code).toBe(0);
  });

  it("captures stderr separately and reports the real exit code", async () => {
    const events = await collect(
      spawnAgent(
        process.execPath,
        ["-e", "console.error('uh oh');process.exit(2);"],
        { cwd: tmpdir() },
      ),
    );
    expect(events.filter((e) => e.type === "stderr").map((e) => e.data)).toEqual(
      ["uh oh"],
    );
    const exit = expectExit(events);
    expect(exit.code).toBe(2);
  });

  it("kills the subprocess when the abort signal fires", async () => {
    const abort = new AbortController();
    // 30s sleep — would hang the test if abort didn't actually fire.
    const iter = spawnAgent(
      process.execPath,
      ["-e", "setTimeout(() => {}, 30000);"],
      { cwd: tmpdir(), signal: abort.signal },
    );

    // Trigger abort once the subprocess is alive.
    setTimeout(() => abort.abort(), 50);

    const events = await collect(iter);
    const exit = expectExit(events);
    // Killed by signal → -1 sentinel.
    expect(exit.code).toBe(-1);
  });

  it("kills the subprocess when the timeout expires", async () => {
    const events = await collect(
      spawnAgent(
        process.execPath,
        ["-e", "setTimeout(() => {}, 30000);"],
        { cwd: tmpdir(), timeoutMs: 100 },
      ),
    );
    const exit = expectExit(events);
    expect(exit.code).toBe(-1);
    // We expect a "drydock: aborting agent (timeout)" line on stderr so the
    // user can tell from the transcript why the agent stopped.
    expect(
      events.some(
        (e) => e.type === "stderr" && e.data.includes("timeout"),
      ),
    ).toBe(true);
  });

  it("emits a single exit event even when the binary is missing", async () => {
    const events = await collect(
      spawnAgent("definitely-not-a-real-binary-xyz123", [], {
        cwd: tmpdir(),
      }),
    );
    const exitEvents = events.filter((e) => e.type === "exit");
    expect(exitEvents).toHaveLength(1);
    expect(exitEvents[0].code).toBe(-1);
    expect(events.some((e) => e.type === "stderr")).toBe(true);
  });
});
