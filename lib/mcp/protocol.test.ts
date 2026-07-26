import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetDbForTests, getDb } from "../db/index";
import { createBacklogItem, listBacklog, triageBacklogItem } from "../db/backlog";
import { handleMessage, parseRequest, PROTOCOL_VERSION } from "./protocol";
import {
  buildTools,
  WITHHELD_FROM_UNTRUSTED,
  WITHHELD_TOOLS,
} from "./tools";

const INFO = { name: "drydock", version: "0.1.0" };

beforeEach(() => {
  _resetDbForTests();
  const dir = mkdtempSync(join(tmpdir(), "drydock-mcp-test-"));
  process.env.DRYDOCK_DB_PATH = join(dir, "test.db");
  getDb();
});

function tools(caller: "ai-generated" | "manual" = "ai-generated") {
  return buildTools(caller);
}

async function call(
  name: string,
  args: Record<string, unknown> = {},
  caller: "ai-generated" | "manual" = "ai-generated",
) {
  const response = await handleMessage(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    },
    tools(caller),
    INFO,
  );
  const result = response?.result as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  return {
    isError: result.isError === true,
    data: result.isError ? result.content[0].text : JSON.parse(result.content[0].text),
  };
}

describe("protocol", () => {
  it("answers initialize with the protocol version and server info", async () => {
    const res = await handleMessage(
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      tools(),
      INFO,
    );
    expect(res?.result).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
      serverInfo: INFO,
    });
  });

  it("returns NOTHING for a notification", async () => {
    // Replying to a notification is a protocol violation that some
    // clients treat as fatal.
    expect(
      await handleMessage(
        { jsonrpc: "2.0", method: "notifications/initialized" },
        tools(),
        INFO,
      ),
    ).toBeNull();
  });

  it("lists tools with their schemas", async () => {
    const res = await handleMessage(
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      tools("manual"),
      INFO,
    );
    const listed = (
      res?.result as {
        tools: Array<{ name: string; inputSchema: unknown }>;
      }
    ).tools;
    expect(listed.map((t) => t.name)).toContain("get_usage_stats");
    // Every tool advertises a schema; a model can't call what it can't
    // see the shape of.
    expect(listed.every((t) => typeof t.inputSchema === "object")).toBe(true);
  });

  it("gives a content-consuming session PROPOSE-ONLY, nothing else", async () => {
    // The lethal-trifecta guard, tightened after Codex's P1 on PR #8.
    // Withholding `dispatch_task` alone was not enough: `list_backlog`,
    // `list_tasks`, and `get_usage_stats` pull private local state into
    // the context of a session that is already reading attacker-
    // controlled pages and has its own web access to send it back out.
    // `burn_down_item` additionally mutates. The ideas session gets
    // exactly one tool.
    const res = await handleMessage(
      { jsonrpc: "2.0", id: 3, method: "tools/list" },
      tools("ai-generated"),
      INFO,
    );
    const names = (res?.result as { tools: Array<{ name: string }> }).tools.map(
      (t) => t.name,
    );
    expect(names).toEqual(["add_backlog_item"]);
    for (const withheld of [...WITHHELD_TOOLS, ...WITHHELD_FROM_UNTRUSTED]) {
      expect(names).not.toContain(withheld);
    }
  });

  it("refuses to CALL a tool the caller isn't allowed, not just hide it", async () => {
    // Hiding a tool from tools/list is cosmetic if the call still works —
    // a model that learned the name elsewhere would sail straight
    // through. The allowlist has to gate dispatch, not just discovery.
    const res = await handleMessage(
      {
        jsonrpc: "2.0",
        id: 31,
        method: "tools/call",
        params: { name: "list_backlog", arguments: {} },
      },
      tools("ai-generated"),
      INFO,
    );
    expect(res?.error?.code).toBe(-32602);
  });

  it("still gives a human-driven session the read tools", async () => {
    const res = await handleMessage(
      { jsonrpc: "2.0", id: 32, method: "tools/list" },
      tools("manual"),
      INFO,
    );
    const names = (res?.result as { tools: Array<{ name: string }> }).tools.map(
      (t) => t.name,
    );
    expect(names).toContain("list_backlog");
    expect(names).toContain("get_usage_stats");
    expect(names).toContain("burn_down_item");
    for (const withheld of WITHHELD_TOOLS) {
      expect(names).not.toContain(withheld);
    }
  });

  it("errors on an unknown method and an unknown tool", async () => {
    const method = await handleMessage(
      { jsonrpc: "2.0", id: 4, method: "nope/nope" },
      tools(),
      INFO,
    );
    expect(method?.error?.code).toBe(-32601);

    const tool = await handleMessage(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "dispatch_task", arguments: {} },
      },
      tools(),
      INFO,
    );
    expect(tool?.error?.code).toBe(-32602);
  });

  it("reports a tool failure as a tool result, not a transport error", async () => {
    // The model should see what went wrong and correct itself, rather
    // than the call failing at the transport layer.
    const res = await call("add_backlog_item", {});
    expect(res.isError).toBe(true);
    expect(String(res.data)).toContain("title");
  });
});

describe("parseRequest", () => {
  it("rejects anything that isn't a JSON-RPC request", () => {
    for (const bad of ["", "   ", "not json", "[1,2,3]", '{"no":"method"}']) {
      expect(parseRequest(bad)).toBeNull();
    }
  });

  it("accepts a well-formed request", () => {
    expect(parseRequest('{"jsonrpc":"2.0","id":1,"method":"ping"}')).toMatchObject(
      { method: "ping" },
    );
  });
});

describe("tools", () => {
  it("add_backlog_item lands in the INBOX as proposed, never the backlog", async () => {
    const res = await call("add_backlog_item", {
      title: "nightly idea: rate limit the tunnel",
      description: "file:///specs/rate-limit.md",
    });
    expect(res.data.landed_in).toBe("inbox");
    expect(listBacklog({ stage: "triaged" })).toHaveLength(0);
    const inbox = listBacklog({ stage: "inbox" });
    expect(inbox).toHaveLength(1);
    expect(inbox[0].status).toBe("proposed");
    expect(inbox[0].source).toBe("ai-generated");
  });

  it("forces the caller's identity — a caller cannot claim to be manual", async () => {
    // A tool that read `source` from its arguments would let a machine
    // write straight into the trusted list, which is the entire thing
    // the inbox prevents.
    const res = await call("add_backlog_item", {
      title: "sneaky",
      source: "manual",
      status: "idea",
      triaged_at: 1,
    } as Record<string, unknown>);
    expect(res.isError).toBe(false);
    const [item] = listBacklog({ stage: "inbox" });
    expect(item.source).toBe("ai-generated");
    expect(item.triaged_at).toBeNull();
  });

  it("is idempotent on a repeated external_id", async () => {
    await call("add_backlog_item", { title: "a", external_id: "spec-1" });
    const second = await call("add_backlog_item", {
      title: "a",
      external_id: "spec-1",
    });
    expect(second.data.outcome).toBe("duplicate");
    expect(listBacklog()).toHaveLength(1);
  });

  it("reports near-duplicates without dropping the new item", async () => {
    createBacklogItem({ title: "Add a rate limiter to the tunnel endpoints" });
    const res = await call("add_backlog_item", {
      title: "Add rate limiter to tunnel endpoints",
    });
    expect(res.data.outcome).toBe("created");
    expect(res.data.similar.length).toBeGreaterThan(0);
  });

  it("list_backlog defaults to the accepted list, not everything", async () => {
    const accepted = createBacklogItem({ title: "accepted", source: "manual" });
    triageBacklogItem(accepted.id);
    createBacklogItem({ title: "captured", source: "shortcut" });

    const res = await call("list_backlog", {}, "manual");
    expect(res.data.count).toBe(1);
    expect(res.data.items[0].title).toBe("accepted");
    expect(res.data.inbox_count).toBe(1);
  });

  it("burn_down_item refuses an item still sitting in the inbox", async () => {
    // Letting a machine burn down an unaccepted item would route around
    // the inbox entirely.
    const item = createBacklogItem({ title: "untriaged", source: "shortcut" });
    const res = await call("burn_down_item", { id: item.id }, "manual");
    expect(res.data.ok).toBe(false);
    expect(res.data.reason).toContain("inbox");
  });

  it("burn_down_item creates a PENDING task a human still has to run", async () => {
    const item = createBacklogItem({ title: "accepted", source: "manual" });
    triageBacklogItem(item.id);
    const res = await call("burn_down_item", { id: item.id }, "manual");
    // No project assigned, so it reports why rather than throwing.
    expect(res.data.ok).toBe(false);
    expect(res.data.code).toBe("project_required");
  });

  it("get_usage_stats says Google is activity, not tokens", async () => {
    const res = await call("get_usage_stats", { days: 7 }, "manual");
    expect(res.data.window_days).toBe(7);
    expect(res.data.note).toContain("no token counts");
  });

  it("list_tasks reports an unknown status instead of matching nothing", async () => {
    const res = await call("list_tasks", { status: "bogus" }, "manual");
    expect(res.data.error).toContain("unknown status");
  });
});
