import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { POST as sessionsPOST } from "@/app/api/sessions/route";
import { _resetDbForTests, getDb } from "../db/index";
import { createProject } from "../db/projects";
import { createTask, getTask, updateTask } from "../db/tasks";
import { getLatestRunForTask } from "../db/runs";
import { MAX_CONCURRENT_RUNS_KEY } from "./dispatch";
import { SESSION_PROMPT_MAX_CHARS } from "./prompt";
import { _resetHubForTests } from "./hub";
import { setSetting } from "../db/settings";
import { _resetSessionRateLimitForTests } from "../api/rate-limit";

beforeEach(() => {
  _resetDbForTests();
  _resetHubForTests();
  const dir = mkdtempSync(join(tmpdir(), "drydock-sessions-route-test-"));
  process.env.DRYDOCK_DB_PATH = join(dir, "test.db");
  getDb();
  // Every dispatch in this file resolves to the no-op stub provider — the
  // route has no providerFactory injection point, and these tests must
  // never spawn a real CLI.
  process.env.DRYDOCK_PROVIDER_STUB = "1";
  // Fresh bucket per test so earlier cases can't eat a later case's tokens.
  _resetSessionRateLimitForTests();
});

afterEach(() => {
  delete process.env.DRYDOCK_PROVIDER_STUB;
  delete process.env.DRYDOCK_LOCAL_DISPATCH_ONLY;
});

/** A project whose path really exists (the route preflights it). */
function projectOnDisk(overrides: { provider?: "claude" | "gemini" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "drydock-sessions-project-"));
  return createProject({ name: "P", path: dir, ...overrides });
}

function req(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost:3000/api/sessions", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "Content-Type": "application/json", host: "localhost:3000", ...headers },
  });
}

/**
 * The route is fire-and-forget (it answers before the stub run finishes),
 * so post-conditions about the run poll until the task settles. Also keeps
 * the background finalize from outliving the test's DB.
 */
async function waitForTerminal(taskId: string, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const task = getTask(taskId);
    if (task && (task.status === "done" || task.status === "failed")) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`task ${taskId} never reached a terminal state`);
}

describe("POST /api/sessions — validation", () => {
  it("400s a missing projectId", async () => {
    const res = await sessionsPOST(req({ prompt: "hi" }));
    expect(res.status).toBe(400);
  });

  it("404s an unknown project", async () => {
    const res = await sessionsPOST(req({ projectId: "nope", prompt: "hi" }));
    expect(res.status).toBe(404);
  });

  it("400s an empty prompt", async () => {
    const p = projectOnDisk();
    const res = await sessionsPOST(req({ projectId: p.id, prompt: "   " }));
    expect(res.status).toBe(400);
  });

  it("400s an oversize prompt", async () => {
    const p = projectOnDisk();
    const res = await sessionsPOST(
      req({ projectId: p.id, prompt: "x".repeat(SESSION_PROMPT_MAX_CHARS + 1) }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/too long/);
  });

  it("400s an unknown provider", async () => {
    const p = projectOnDisk();
    const res = await sessionsPOST(
      req({ projectId: p.id, prompt: "hi", provider: "codex" }),
    );
    expect(res.status).toBe(400);
  });

  it("400s an unknown model", async () => {
    const p = projectOnDisk();
    const res = await sessionsPOST(
      req({ projectId: p.id, prompt: "hi", model: "gpt-4o" }),
    );
    expect(res.status).toBe(400);
  });

  it("400s a model override on a non-claude provider", async () => {
    const p = projectOnDisk();
    const res = await sessionsPOST(
      req({
        projectId: p.id,
        prompt: "hi",
        provider: "gemini",
        model: "claude-opus-4-7",
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/claude/);
  });

  it("400s an unknown autonomy level", async () => {
    const p = projectOnDisk();
    const res = await sessionsPOST(
      req({ projectId: p.id, prompt: "hi", autonomy: "yolo" }),
    );
    expect(res.status).toBe(400);
  });

  it("400s an autonomy override on a non-claude provider (unenforceable)", async () => {
    const p = projectOnDisk();
    const res = await sessionsPOST(
      req({
        projectId: p.id,
        prompt: "hi",
        provider: "gemini",
        autonomy: "readonly",
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/claude/);
  });

  it("400s malformed JSON", async () => {
    const res = await sessionsPOST(req("this is not json"));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/sessions — DD-017 path preflight", () => {
  it("409s when the project path doesn't exist, naming the path", async () => {
    const ghost = join(tmpdir(), "drydock-sessions-ghost", "missing-repo");
    const p = createProject({ name: "Ghost", path: ghost });
    const res = await sessionsPOST(req({ projectId: p.id, prompt: "hi" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain(ghost);
  });
});

describe("POST /api/sessions — kickoff", () => {
  it("creates the task with a synthesized title + overrides and dispatches it", async () => {
    const p = projectOnDisk();
    const prompt =
      "Fix the flaky auth test\n\nIt fails on CI because token refresh races the clock.";
    const res = await sessionsPOST(
      req({
        projectId: p.id,
        prompt,
        model: "claude-opus-4-7",
        autonomy: "readonly",
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.taskId).toBeTruthy();
    expect(body.runId).toBeTruthy();

    const task = getTask(body.taskId);
    expect(task?.source).toBe("session");
    expect(task?.title).toBe("Fix the flaky auth test");
    expect(task?.description).toBe(prompt);
    expect(task?.provider).toBe("claude");
    expect(task?.model).toBe("claude-opus-4-7");
    expect(task?.autonomy).toBe("readonly");

    await waitForTerminal(body.taskId);
    expect(getTask(body.taskId)?.status).toBe("done");
    const run = getLatestRunForTask(body.taskId);
    expect(run?.id).toBe(body.runId);
    // The stub provider reported its fixed session id — proof the dispatch
    // pipeline (not just the insert) ran, and the transcript carries the
    // override notes.
    expect(run?.session_id).toBe("stub-session-1");
    expect(run?.output).toMatch(/\[drydock\] model: claude-opus-4-7/);
    expect(run?.output).toMatch(/autonomy profile: readonly/);
  });

  it("defaults provider to the project's and leaves overrides null", async () => {
    const p = projectOnDisk({ provider: "gemini" });
    const res = await sessionsPOST(req({ projectId: p.id, prompt: "hi there" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    const task = getTask(body.taskId);
    expect(task?.provider).toBe("gemini");
    expect(task?.model).toBeNull();
    expect(task?.autonomy).toBeNull();
    await waitForTerminal(body.taskId);
  });

  it("202s with a queue position when the concurrency cap is full", async () => {
    setSetting(MAX_CONCURRENT_RUNS_KEY, "1");
    const p = projectOnDisk();
    // Occupy the only slot.
    const busy = createTask({
      project_id: p.id,
      title: "busy",
      description: "holds the slot",
    });
    updateTask(busy.id, { status: "running" });

    const res = await sessionsPOST(
      req({ projectId: p.id, prompt: "queued ask", autonomy: "full" }),
    );
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.queued).toBe(true);
    expect(body.position).toBe(1);
    // Overrides are columns, so the queued task keeps them for the drain.
    const task = getTask(body.taskId);
    expect(task?.status).toBe("queued");
    expect(task?.autonomy).toBe("full");
    expect(task?.source).toBe("session");
  });
});

describe("POST /api/sessions — rate limit", () => {
  it("429s after the burst budget with a Retry-After header", async () => {
    // Burn the 10-token burst with cheap invalid requests (the bucket sits
    // before validation on purpose).
    for (let i = 0; i < 10; i++) {
      const res = await sessionsPOST(req({}));
      expect(res.status).toBe(400);
    }
    const res = await sessionsPOST(req({}));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
  });
});

describe("POST /api/sessions — DRYDOCK_LOCAL_DISPATCH_ONLY", () => {
  it("403s tunnel traffic when enabled (cf headers present)", async () => {
    process.env.DRYDOCK_LOCAL_DISPATCH_ONLY = "1";
    const res = await sessionsPOST(req({}, { "cf-ray": "8f00ba11" }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/DRYDOCK_LOCAL_DISPATCH_ONLY/);
  });

  it("403s a non-local host when enabled", async () => {
    process.env.DRYDOCK_LOCAL_DISPATCH_ONLY = "1";
    const res = await sessionsPOST(req({}, { host: "drydock.example.com" }));
    expect(res.status).toBe(403);
  });

  it("still serves localhost when enabled", async () => {
    process.env.DRYDOCK_LOCAL_DISPATCH_ONLY = "1";
    // Passes the guard and reaches validation (missing projectId → 400).
    const res = await sessionsPOST(req({}));
    expect(res.status).toBe(400);
  });
});
