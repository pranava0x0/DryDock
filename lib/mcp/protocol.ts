import type { ToolDefinition } from "./tools";

/**
 * A minimal MCP server over JSON-RPC 2.0.
 *
 * ── Why no `@modelcontextprotocol/sdk` ──────────────────────────────────
 * The surface actually needed here is three methods — `initialize`,
 * `tools/list`, `tools/call` — plus the `notifications/initialized`
 * no-op. That's what's below, in about a hundred lines of pure,
 * dependency-free, unit-testable code.
 *
 * Adding the SDK would mean a new transitive dependency tree in a repo
 * whose install policy is `--ignore-scripts` and whose design system
 * bans a charting library for four card types. It would also put the
 * server's behaviour behind a version bump we don't control, for a
 * protocol we use a tenth of. If DryDock ever needs resources, prompts,
 * sampling, or progress notifications, take the dependency then — this
 * file is small enough to delete without regret.
 *
 * The dispatch below is pure: messages in, messages out, no I/O. The
 * stdio plumbing lives in `mcp/server.ts` so this half stays testable
 * without spawning a process.
 */

export const PROTOCOL_VERSION = "2025-06-18";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

/** JSON-RPC reserved codes. */
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

export interface ServerInfo {
  name: string;
  version: string;
}

/**
 * Handle one request.
 *
 * Returns `null` for notifications (no `id`), which by the JSON-RPC spec
 * must not be answered — replying to one is a protocol violation that
 * some clients treat as fatal.
 */
export async function handleMessage(
  request: JsonRpcRequest,
  tools: ToolDefinition[],
  info: ServerInfo,
): Promise<JsonRpcResponse | null> {
  const isNotification = request.id === undefined || request.id === null;
  const id = request.id ?? null;

  switch (request.method) {
    case "initialize":
      return reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: info,
      });

    case "notifications/initialized":
    case "initialized":
      return null;

    case "ping":
      return reply(id, {});

    case "tools/list":
      return reply(id, {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });

    case "tools/call": {
      const name =
        typeof request.params?.name === "string" ? request.params.name : "";
      const tool = tools.find((t) => t.name === name);
      if (!tool) {
        return fail(id, INVALID_PARAMS, `Unknown tool: ${name || "(none)"}`);
      }
      const args =
        typeof request.params?.arguments === "object" &&
        request.params.arguments !== null
          ? (request.params.arguments as Record<string, unknown>)
          : {};
      try {
        const output = await tool.handler(args);
        return reply(id, {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        });
      } catch (err) {
        // A tool error is reported as a tool *result* with isError, not
        // as a JSON-RPC error: the model should see what went wrong and
        // be able to correct itself, rather than the whole call failing
        // at the transport layer.
        return reply(id, {
          content: [
            { type: "text", text: `Error: ${(err as Error).message}` },
          ],
          isError: true,
        });
      }
    }

    default:
      if (isNotification) return null;
      return fail(id, METHOD_NOT_FOUND, `Unknown method: ${request.method}`);
  }
}

function reply(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function fail(
  id: string | number | null,
  code: number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/**
 * Parse one line into a request.
 *
 * Malformed input yields null and the caller drops the line. Answering a
 * parse failure isn't possible anyway — without a valid `id` there's
 * nothing to answer.
 */
export function parseRequest(line: string): JsonRpcRequest | null {
  if (typeof line !== "string" || line.trim().length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(line);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    const request = parsed as Record<string, unknown>;
    if (typeof request.method !== "string") return null;
    return request as unknown as JsonRpcRequest;
  } catch {
    return null;
  }
}

export { INTERNAL_ERROR, INVALID_PARAMS, METHOD_NOT_FOUND };
