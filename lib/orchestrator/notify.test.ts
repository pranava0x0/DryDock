import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetDbForTests, getDb } from "../db/index";
import { createProject } from "../db/projects";
import { createTask } from "../db/tasks";
import { notifyRunCompletion, postCompletionNotice } from "./notify";
import type { CompletionNotice } from "./notify";

const NOTICE: CompletionNotice = {
  task_id: "t1",
  title: "do thing",
  project: "P",
  status: "done",
  cost_usd: 0.12,
  branch: "drydock/t1-do-thing",
};

describe("postCompletionNotice", () => {
  it("POSTs the notice as JSON and reports sent", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const outcome = await postCompletionNotice(
      "https://ntfy.example/drydock",
      NOTICE,
      async (url, init) => {
        calls.push({ url, body: init.body });
        return { ok: true };
      },
    );
    expect(outcome).toBe("sent");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://ntfy.example/drydock");
    expect(JSON.parse(calls[0].body)).toEqual(NOTICE);
  });

  it("retries once on a non-2xx and reports sent-after-retry", async () => {
    let attempts = 0;
    const outcome = await postCompletionNotice(
      "https://hook.example",
      NOTICE,
      async () => ({ ok: ++attempts > 1 }),
    );
    expect(outcome).toBe("sent-after-retry");
    expect(attempts).toBe(2);
  });

  it("gives up after two attempts and never throws", async () => {
    let attempts = 0;
    const outcome = await postCompletionNotice("https://hook.example", NOTICE, async () => {
      attempts++;
      throw new Error("connection refused");
    });
    expect(outcome).toBe("failed");
    expect(attempts).toBe(2);
  });
});

describe("notifyRunCompletion", () => {
  beforeEach(() => {
    _resetDbForTests();
    const dir = mkdtempSync(join(tmpdir(), "drydock-notify-test-"));
    process.env.DRYDOCK_DB_PATH = join(dir, "test.db");
    getDb();
  });

  afterEach(() => {
    delete process.env.DRYDOCK_NOTIFY_WEBHOOK_URL;
  });

  it("is a no-op when no webhook is configured", async () => {
    const outcome = await notifyRunCompletion({
      taskId: "whatever",
      project: "P",
      status: "done",
      costUsd: null,
    });
    expect(outcome).toBe("skipped");
  });

  it("does not throw even when the env URL is unreachable garbage", async () => {
    // Real fetch against a scheme that fails instantly — proves the promise
    // resolves (to failed) rather than rejecting into the dispatcher.
    process.env.DRYDOCK_NOTIFY_WEBHOOK_URL = "http://127.0.0.1:1/unreachable";
    const p = createProject({ name: "P", path: "/tmp/p" });
    const t = createTask({ project_id: p.id, title: "t", description: "d" });
    const outcome = await notifyRunCompletion({
      taskId: t.id,
      project: p.name,
      status: "failed",
      costUsd: 0.01,
    });
    expect(outcome).toBe("failed");
  });
});
