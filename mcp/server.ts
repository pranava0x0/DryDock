#!/usr/bin/env node
import { createInterface } from "node:readline";
import { buildTools, type CallerIdentity } from "../lib/mcp/tools";
import { handleMessage, parseRequest } from "../lib/mcp/protocol";

/**
 * DryDock's MCP server (EP-14 Spec A) — stdio entry point.
 *
 * Register once per satellite:
 *
 *   claude mcp add --scope user drydock -- npx tsx <abs-path>/mcp/server.ts
 *
 * The caller's identity is set by the environment, NOT by the caller:
 *
 *   DRYDOCK_MCP_CALLER=ai-generated   (default — proposals land in the
 *                                      inbox as `proposed`)
 *   DRYDOCK_MCP_CALLER=manual         (a human-driven session)
 *
 * Defaulting to the *less* trusted identity is deliberate: a
 * misconfiguration should under-trust, never over-trust.
 *
 * Everything goes to stdout as JSON-RPC and nothing else — a stray
 * console.log would corrupt the stream, which is why the only diagnostic
 * output in this file is on stderr.
 */

const caller: CallerIdentity =
  process.env.DRYDOCK_MCP_CALLER === "manual" ? "manual" : "ai-generated";

const tools = buildTools(caller);
const info = { name: "drydock", version: "0.1.0" };

process.stderr.write(
  `[drydock-mcp] ready · caller=${caller} · ${tools.length} tools\n`,
);

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  const request = parseRequest(line);
  if (!request) return;
  void handleMessage(request, tools, info)
    .then((response) => {
      // Notifications get no reply — answering one is a protocol
      // violation some clients treat as fatal.
      if (response === null) return;
      process.stdout.write(`${JSON.stringify(response)}\n`);
    })
    .catch((err: Error) => {
      process.stderr.write(`[drydock-mcp] ${err.message}\n`);
    });
});

rl.on("close", () => process.exit(0));
