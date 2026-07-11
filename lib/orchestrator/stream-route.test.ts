import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { GET as streamGET } from "@/app/api/tasks/[id]/stream/route";
import { _resetDbForTests, getDb } from "../db/index";
import { createProject } from "../db/projects";
import { createTask, getTask } from "../db/tasks";
import { getLatestRunForTask } from "../db/runs";
import { runTaskWithCap } from "./dispatch";
import { _resetHubForTests } from "./hub";
import type { AgentProvider } from "../providers/types";

beforeEach(() => {
  _resetDbForTests();
  _resetHubForTests();
  const dir = mkdtempSync(join(tmpdir(), "drydock-stream-route-test-"));
  process.env.DRYDOCK_DB_PATH = join(dir, "test.db");
  getDb();
});

const noGit = async (_path: string): Promise<boolean> => false;

function gatedProvider(): { provider: AgentProvider; release: () => void } {
  let releaseFn: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    releaseFn = resolve;
  });
  return {
    provider: {
      name: "claude",
      async *run() {
        yield { type: "stdout" as const, data: "working" };
        await gate;
        yield { type: "exit" as const, data: "", code: 0 };
      },
    },
    release: () => releaseFn?.(),
  };
}

describe("SSE stream route", () => {
  it("a dropped stream connection does NOT kill the run (DD regression pin)", async () => {
    // Old behavior: the route aborted the run's subprocess when the SSE
    // client disconnected — a phone locking its screen killed healthy
    // agents. This pins the fix: disconnect closes the stream only.
    const p = createProject({ name: "P", path: "/tmp/p" });
    const t = createTask({ project_id: p.id, title: "s", description: "x" });
    const gate = gatedProvider();
    const r = runTaskWithCap(t.id, {
      providerFactory: () => gate.provider,
      isGitRepo: noGit,
    });
    if (r.queued) throw new Error("unreachable");

    // Client connects to the live stream…
    const clientAbort = new AbortController();
    const request = new NextRequest("http://localhost/api/tasks/x/stream", {
      signal: clientAbort.signal,
    });
    const response = await streamGET(request, {
      params: Promise.resolve({ id: t.id }),
    });
    expect(response.status).toBe(200);

    // …then drops (screen lock, tunnel blip). The run must survive.
    clientAbort.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));

    gate.release();
    await r.done;

    expect(getLatestRunForTask(t.id)?.status).toBe("success");
    expect(getTask(t.id)?.status).toBe("done");
  });

  it("replays a terminal run instead of hanging", async () => {
    const p = createProject({ name: "P", path: "/tmp/p" });
    const t = createTask({ project_id: p.id, title: "s", description: "x" });
    const gate = gatedProvider();
    const r = runTaskWithCap(t.id, {
      providerFactory: () => gate.provider,
      isGitRepo: noGit,
    });
    if (r.queued) throw new Error("unreachable");
    gate.release();
    await r.done;

    const request = new NextRequest("http://localhost/api/tasks/x/stream");
    const response = await streamGET(request, {
      params: Promise.resolve({ id: t.id }),
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("working");
    expect(text).toContain('"exit"');
  });
});
