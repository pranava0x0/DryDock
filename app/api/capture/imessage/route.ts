import type { NextRequest } from "next/server";
import {
  ENABLED_KEY,
  SELF_HANDLE_KEY,
  TRIGGER_KEY,
  getSelfHandle,
  getTriggerPrefix,
  imessageHealth,
  pollImessages,
  seedImessageCursor,
} from "@/lib/integrations/imessage";
import { getSetting, setSetting } from "@/lib/db/settings";
import { badRequest, ok, serverError } from "@/lib/api/json";

export const runtime = "nodejs";

/** GET — current configuration and health, without polling. */
export async function GET(): Promise<Response> {
  try {
    return ok({
      enabled: getSetting(ENABLED_KEY) === "true",
      selfHandle: getSelfHandle(),
      trigger: getTriggerPrefix(),
      health: imessageHealth(),
    });
  } catch (err) {
    return serverError((err as Error).message);
  }
}

/**
 * POST — configure and/or poll the iMessage capture channel (EP-12 C).
 *
 * `{ enabled?, self_handle?, trigger?, poll? }`
 *
 * Enabling **seeds the cursor at the newest message** rather than
 * starting from zero: otherwise the first poll walks backwards through
 * years of texts and files every one that ever began with the trigger
 * word. That's the "helpful" behaviour that makes a user switch a
 * feature straight back off.
 */
export async function POST(request: NextRequest): Promise<Response> {
  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    // An empty body means "just poll with the current settings".
  }
  const raw = (body ?? {}) as Record<string, unknown>;

  try {
    if (raw.self_handle !== undefined) {
      if (raw.self_handle !== null && typeof raw.self_handle !== "string") {
        return badRequest("`self_handle` must be a string or null");
      }
      setSetting(SELF_HANDLE_KEY, (raw.self_handle ?? "") as string);
    }
    if (raw.trigger !== undefined) {
      if (typeof raw.trigger !== "string") {
        return badRequest("`trigger` must be a string (empty = capture all)");
      }
      setSetting(TRIGGER_KEY, raw.trigger);
    }

    let seeded: { ok: boolean; rowid: number | null } | null = null;
    if (raw.enabled !== undefined) {
      if (typeof raw.enabled !== "boolean") {
        return badRequest("`enabled` must be a boolean");
      }
      const wasEnabled = getSetting(ENABLED_KEY) === "true";
      setSetting(ENABLED_KEY, raw.enabled ? "true" : "false");
      // Seed only on the enable transition — re-seeding on every save
      // would skip anything texted since the last one.
      if (raw.enabled && !wasEnabled) seeded = seedImessageCursor();
    }

    const polled = raw.poll === false ? null : pollImessages();
    return ok({
      enabled: getSetting(ENABLED_KEY) === "true",
      selfHandle: getSelfHandle(),
      trigger: getTriggerPrefix(),
      health: imessageHealth(),
      seeded,
      polled,
    });
  } catch (err) {
    return serverError((err as Error).message);
  }
}
