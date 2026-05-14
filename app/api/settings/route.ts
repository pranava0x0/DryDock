import type { NextRequest } from "next/server";
import {
  getBooleanSetting,
  setSetting,
} from "@/lib/db/settings";
import { AUTO_CLEANUP_WORKTREE_KEY } from "@/lib/orchestrator/dispatch";
import { badRequest, ok, serverError } from "@/lib/api/json";

export const runtime = "nodejs";

/**
 * Allow-list of writable settings. Each entry maps the public key to a
 * serializer/parser pair so the route stays the only place we accept
 * external input. Keeps the rest of the app from having to guard against
 * raw `setSetting(key, value)` calls with arbitrary keys.
 */
type SettingShape = "boolean";

interface WritableSetting {
  shape: SettingShape;
  read: () => unknown;
}

const WRITABLE: Record<string, WritableSetting> = {
  [AUTO_CLEANUP_WORKTREE_KEY]: {
    shape: "boolean",
    read: () => getBooleanSetting(AUTO_CLEANUP_WORKTREE_KEY, false),
  },
};

function snapshot(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(WRITABLE)) {
    out[key] = entry.read();
  }
  return out;
}

export async function GET(): Promise<Response> {
  try {
    return ok({ settings: snapshot() });
  } catch (err) {
    return serverError((err as Error).message);
  }
}

export async function PUT(request: NextRequest): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("Request body must be valid JSON");
  }
  if (typeof body !== "object" || body === null) {
    return badRequest("Request body must be an object");
  }
  const raw = body as Record<string, unknown>;

  for (const [key, value] of Object.entries(raw)) {
    const entry = WRITABLE[key];
    if (!entry) {
      return badRequest(`Unknown or read-only setting: ${key}`);
    }
    if (entry.shape === "boolean") {
      if (typeof value !== "boolean") {
        return badRequest(`Setting \`${key}\` must be a boolean`);
      }
      setSetting(key, value ? "true" : "false");
    }
  }

  try {
    return ok({ settings: snapshot() });
  } catch (err) {
    return serverError((err as Error).message);
  }
}
