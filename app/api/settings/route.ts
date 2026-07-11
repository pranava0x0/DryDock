import type { NextRequest } from "next/server";
import {
  getBooleanSetting,
  getNumberSetting,
  setSetting,
} from "@/lib/db/settings";
import {
  AUTO_CLEANUP_WORKTREE_KEY,
  MAX_CONCURRENT_RUNS_KEY,
  maxConcurrentRuns,
} from "@/lib/orchestrator/dispatch";
import { CREDITS_KEY } from "@/lib/budget/window";
import { badRequest, ok, serverError } from "@/lib/api/json";

export const runtime = "nodejs";

/**
 * Allow-list of writable settings. Each entry maps the public key to a
 * serializer/parser pair so the route stays the only place we accept
 * external input. Keeps the rest of the app from having to guard against
 * raw `setSetting(key, value)` calls with arbitrary keys.
 */
type SettingShape = "boolean" | "number";

interface WritableSetting {
  shape: SettingShape;
  read: () => unknown;
}

const WRITABLE: Record<string, WritableSetting> = {
  [AUTO_CLEANUP_WORKTREE_KEY]: {
    shape: "boolean",
    read: () => getBooleanSetting(AUTO_CLEANUP_WORKTREE_KEY, true),
  },
  // Optional, manually-entered API credit balance (USD). null when unset.
  [CREDITS_KEY]: {
    shape: "number",
    read: () => getNumberSetting(CREDITS_KEY),
  },
  // Dispatch concurrency cap. Read back as the effective value (clamped,
  // defaulted) so the UI always shows what the dispatcher will actually do.
  [MAX_CONCURRENT_RUNS_KEY]: {
    shape: "number",
    read: () => maxConcurrentRuns(),
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
    } else if (entry.shape === "number") {
      if (value === null) {
        setSetting(key, ""); // clears it — getNumberSetting reads "" as null
      } else if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        setSetting(key, String(value));
      } else {
        return badRequest(
          `Setting \`${key}\` must be a non-negative number or null`,
        );
      }
    }
  }

  try {
    return ok({ settings: snapshot() });
  } catch (err) {
    return serverError((err as Error).message);
  }
}
