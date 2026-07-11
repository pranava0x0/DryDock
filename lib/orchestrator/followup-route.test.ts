import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { POST as followupPOST } from "@/app/api/tasks/[id]/followup/route";
import { _resetDbForTests, getDb } from "../db/index";
import { createProject } from "../db/projects";
import { createTask, getTask } from "../db/tasks";
import { getLatestRunForTask } from "../db/runs";
import { dispatchTask } from "./dispatch";
import { _resetHubForTests } from "./hub";
import type { AgentProvider } from "../providers/types";

beforeEach(() => {
  _resetDbForTests();
  _resetHubForTests();
  const dir = mkdtempSync(join(tmpdir(), "drydock-followup-route-test-"));
  process.env.DRYDOCK_DB_PATH = join(dir, "test.db");
  getDb();
});

const noGit = async (_path: string): Promise<boolean> => false;

function req(prompt: unknown): NextRequest {
  return new NextRequest("http://localhost/api/tasks/x/followup", {
    method: "POST",
    body: JSON.stringify({ prompt }),
    headers: { "Content-Type": "application/json" },
  });
}

function call(id: string, prompt: unknown) {
  return followupPOST(req(prompt), { params: Promise.resolve({ id }) });
}

/** Finish a first run that reports (or doesn't) a session id. */
async function seed(sessionId: string | null) {
  const project = createProject({ name: "P", path: "/tmp/p" });
  const task = createTask({
    project_id: project.id,
    title: "t",
    description: "original ask",
  });
  const provider: AgentProvider = {
    name: "claude",
    async *run() {
      if (sessionId) yield { type: "session" as const, sessionId };
      yield { type: "exit" as const, data: "", code: sessionId ? 0 : 1 };
    },
  };
  const { done } = dispatchTask(task.id, {
    providerFactory: () => provider,
    isGitRepo: noGit,
  });
  await done;
  return { project, task };
}

describe("POST /followup", () => {
  it("400s an empty prompt", async () => {
    const { task } = await seed("sess-A");
    const res = await call(task.id, "  ");
    expect(res.status).toBe(400);
  });

  it("resumes a task that has a session, reporting resumed:true", async () => {
    const { task } = await seed("sess-A");
    const res = await call(task.id, "now update the docs");
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.resumed).toBe(true);
    expect(body.runId).toBeTruthy();
  });

  it("falls back to a fresh feedback-carrying run when there's no session", async () => {
    // A failed run with no session id (e.g. gemini, or died before init).
    const { task } = await seed(null);
    expect(getTask(task.id)?.status).toBe("failed");
    expect(getLatestRunForTask(task.id)?.session_id).toBeFalsy();

    const res = await call(task.id, "please try a different approach");
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.resumed).toBe(false);

    // The feedback was folded into the task description so the fresh run
    // picks it up via buildAgentPrompt.
    expect(getTask(task.id)?.description).toContain(
      "please try a different approach",
    );
  });

  it("409s a fresh-fallback attempt on a task that finished cleanly", async () => {
    // done + no session is unusual; we must not silently re-run finished work.
    const project = createProject({ name: "P", path: "/tmp/p" });
    const task = createTask({
      project_id: project.id,
      title: "t",
      description: "d",
    });
    const { done } = dispatchTask(task.id, {
      providerFactory: () => ({
        name: "claude",
        async *run() {
          // exits 0 (done) but never reports a session
          yield { type: "exit" as const, data: "", code: 0 };
        },
      }),
      isGitRepo: noGit,
    });
    await done;
    expect(getTask(task.id)?.status).toBe("done");

    const res = await call(task.id, "do more");
    expect(res.status).toBe(409);
  });

  it("404s an unknown task", async () => {
    const res = await call("missing", "hi");
    expect(res.status).toBe(404);
  });
});
