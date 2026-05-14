import { describe, it, expect, beforeEach } from "vitest";
import { publish, subscribe, release, _resetHubForTests } from "./hub";
import type { AgentEvent } from "../providers/types";

beforeEach(() => {
  _resetHubForTests();
});

async function collect(
  iter: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

describe("hub publish/subscribe", () => {
  it("replays history to a late subscriber", async () => {
    publish("r1", { type: "stdout", data: "line1" });
    publish("r1", { type: "stdout", data: "line2" });
    publish("r1", { type: "exit", data: "", code: 0 });
    const events = await collect(subscribe("r1"));
    expect(events.map((e) => e.type)).toEqual(["stdout", "stdout", "exit"]);
  });

  it("delivers live events to an existing subscriber", async () => {
    const sub = subscribe("r1");
    publish("r1", { type: "stdout", data: "hello" });
    publish("r1", { type: "exit", data: "", code: 0 });
    const events = await collect(sub);
    expect(events).toEqual([
      { type: "stdout", data: "hello" },
      { type: "exit", data: "", code: 0 },
    ]);
  });

  it("multiple subscribers each get the full transcript", async () => {
    publish("r1", { type: "stdout", data: "a" });
    publish("r1", { type: "exit", data: "", code: 0 });
    const [s1, s2] = await Promise.all([
      collect(subscribe("r1")),
      collect(subscribe("r1")),
    ]);
    expect(s1).toEqual(s2);
    expect(s1).toHaveLength(2);
  });

  it("aborting a subscriber stops iteration cleanly", async () => {
    const abort = new AbortController();
    const events: AgentEvent[] = [];
    const drainPromise = (async () => {
      for await (const e of subscribe("r1", abort.signal)) {
        events.push(e);
      }
    })();
    publish("r1", { type: "stdout", data: "one" });
    // Give the microtask queue a chance to deliver the line.
    await new Promise((r) => setImmediate(r));
    abort.abort();
    await drainPromise;
    expect(events).toEqual([{ type: "stdout", data: "one" }]);
  });

  it("release wakes pending subscribers", async () => {
    let done = false;
    const drainPromise = (async () => {
      for await (const _ of subscribe("r1")) {
        // never runs — no events published
      }
      done = true;
    })();
    await new Promise((r) => setImmediate(r));
    release("r1");
    await drainPromise;
    expect(done).toBe(true);
  });
});
