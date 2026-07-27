import Database from "better-sqlite3";
import { join } from "node:path";
import { homedir } from "node:os";
import { getNumberSetting, getSetting, setSetting } from "../db/settings";
import { intakeCapture } from "../orchestrator/intake";
import {
  appleDateToUnixSeconds,
  decodeAttributedBody,
} from "./typedstream";

/**
 * "Text yourself an idea" (EP-12 Spec C).
 *
 * Polls `~/Library/Messages/chat.db` for messages the user sent to
 * themselves and files them into the inbox.
 *
 * ── Deliberately the LAST capture channel built ─────────────────────────
 * It's the most fragile thing in this codebase and its UX is worse than
 * the one it competes with: texting yourself takes ~4–6s and requires
 * unlocking the phone, while Siri capture is one sentence with the phone
 * still locked. It exists because the muscle memory is already there, not
 * because it's better.
 *
 * Three fragilities, all surfaced rather than hidden:
 *  1. **`attributedBody`.** 52% of messages here have NULL `text`. See
 *     typedstream.ts.
 *  2. **Full Disk Access.** `chat.db` is TCC-protected. The server
 *     inherits FDA from the terminal that launched it, so a future
 *     launchd-managed DryDock *loses* it. `health()` probes by trying to
 *     open the file, and reports the real reason.
 *  3. **Schema drift.** macOS updates move things. Every query is
 *     defensive and a failure degrades to `unavailable`, never to
 *     silence.
 *
 * Read-only throughout: opened `readonly`, and the only writes are to
 * DryDock's own settings and backlog.
 */

export const SELF_HANDLE_KEY = "imessage_self_handle";
export const LAST_ROWID_KEY = "imessage_last_rowid_seen";
export const TRIGGER_KEY = "imessage_trigger_prefix";
export const ENABLED_KEY = "imessage_enabled";

/**
 * Default trigger. Texting yourself a grocery list should not become a
 * backlog item, so a prefix is required unless the user opts out of it.
 */
export const DEFAULT_TRIGGER = "idea:";

export function chatDbPath(): string {
  return (
    process.env.DRYDOCK_IMESSAGE_DB ??
    join(homedir(), "Library", "Messages", "chat.db")
  );
}

export function getSelfHandle(): string | null {
  const value = getSetting(SELF_HANDLE_KEY);
  return value && value.trim().length > 0 ? value.trim() : null;
}

export function getTriggerPrefix(): string {
  const value = getSetting(TRIGGER_KEY);
  // An explicitly-empty prefix means "capture everything I text myself".
  return value === null ? DEFAULT_TRIGGER : value;
}

export type ImessageHealthStatus = "ok" | "disabled" | "unavailable";

export interface ImessageHealth {
  status: ImessageHealthStatus;
  reason: string | null;
  /** Configured self-handle, so the UI can say what it's watching. */
  selfHandle: string | null;
}

/**
 * Probe by actually opening and querying the database.
 *
 * A `stat` is not enough: the file is visible without Full Disk Access
 * and only the read fails, so a presence check would report healthy on a
 * machine that can never read a single message.
 */
export function imessageHealth(): ImessageHealth {
  const selfHandle = getSelfHandle();
  if (getSetting(ENABLED_KEY) !== "true") {
    return {
      status: "disabled",
      reason: "not enabled (Settings → iMessage capture)",
      selfHandle,
    };
  }
  if (!selfHandle) {
    return {
      status: "disabled",
      // Auto-detection is unreliable by design — a Mac has several
      // handles and picking one silently would watch the wrong thread.
      reason: "no self-handle configured — set the number or email you text",
      selfHandle: null,
    };
  }

  let db: Database.Database;
  try {
    db = new Database(chatDbPath(), { readonly: true, fileMustExist: true });
  } catch (err) {
    return { status: "unavailable", reason: explain(err), selfHandle };
  }
  try {
    db.prepare("SELECT ROWID FROM message LIMIT 1").get();
    return { status: "ok", reason: null, selfHandle };
  } catch (err) {
    return { status: "unavailable", reason: explain(err), selfHandle };
  } finally {
    try {
      db.close();
    } catch {
      // Already closed.
    }
  }
}

function explain(err: unknown): string {
  const message = (err as Error).message ?? String(err);
  if (/authorization denied|operation not permitted|EPERM|EACCES/i.test(message)) {
    return "no Full Disk Access — grant it to the terminal running DryDock (System Settings → Privacy & Security → Full Disk Access)";
  }
  if (/unable to open database|no such file/i.test(message)) {
    return "chat.db not found — is Messages set up on this Mac?";
  }
  return message;
}

export interface ImessageCapture {
  rowid: number;
  /** Decoded body, or null when `attributedBody` couldn't be read. */
  text: string | null;
  at: number;
}

export interface ImessagePollResult {
  status: ImessageHealthStatus;
  reason: string | null;
  /** Messages examined. */
  scanned: number;
  captured: number;
  /** Captured but with unreadable text — surfaced, never dropped. */
  unreadable: number;
  /** Skipped because they lacked the trigger prefix. */
  skipped: number;
  lastRowid: number | null;
}

interface MessageRow {
  ROWID: number;
  text: string | null;
  attributedBody: Buffer | null;
  date: number;
}

/** Bounded so a first run against a 949k-message database can't hang. */
const MAX_PER_POLL = 200;

export function pollImessages(now: Date = new Date()): ImessagePollResult {
  const health = imessageHealth();
  if (health.status !== "ok") {
    return {
      status: health.status,
      reason: health.reason,
      scanned: 0,
      captured: 0,
      unreadable: 0,
      skipped: 0,
      lastRowid: null,
    };
  }

  const selfHandle = health.selfHandle!;
  const since = getNumberSetting(LAST_ROWID_KEY);
  const trigger = getTriggerPrefix();

  const result: ImessagePollResult = {
    status: "ok",
    reason: null,
    scanned: 0,
    captured: 0,
    unreadable: 0,
    skipped: 0,
    lastRowid: since,
  };

  const db = new Database(chatDbPath(), { readonly: true, fileMustExist: true });
  let rows: MessageRow[];
  try {
    // `is_from_me = 1` AND the handle is the user's own — that pair is
    // what identifies the note-to-self thread. Matching on handle alone
    // would also catch messages *received* there from another device.
    rows = db
      .prepare(
        `SELECT m.ROWID, m.text, m.attributedBody, m.date
           FROM message m
           JOIN handle h ON h.ROWID = m.handle_id
          WHERE m.is_from_me = 1
            AND h.id = ?
            AND m.ROWID > ?
          ORDER BY m.ROWID ASC
          LIMIT ?`,
      )
      .all(selfHandle, since ?? 0, MAX_PER_POLL) as MessageRow[];
  } catch (err) {
    return {
      ...result,
      status: "unavailable",
      reason: explain(err),
    };
  } finally {
    try {
      db.close();
    } catch {
      // Already closed.
    }
  }

  for (const row of rows) {
    result.scanned += 1;
    result.lastRowid = row.ROWID;

    const body =
      row.text ??
      decodeAttributedBody(
        row.attributedBody ? new Uint8Array(row.attributedBody) : null,
      );

    if (body === null) {
      // A message arrived and we could not read it. Creating a visible
      // placeholder is the honest move — silently skipping would lose a
      // thought with no trace that anything happened.
      intakeCapture({
        text: `(iMessage capture — text unreadable, open Messages) #${row.ROWID}`,
        source: "imessage",
        externalId: `imessage:${row.ROWID}`,
      });
      result.unreadable += 1;
      result.captured += 1;
      continue;
    }

    const trimmed = body.trim();
    if (trigger.length > 0) {
      if (!trimmed.toLowerCase().startsWith(trigger.toLowerCase())) {
        result.skipped += 1;
        continue;
      }
    }
    const payload =
      trigger.length > 0 ? trimmed.slice(trigger.length).trim() : trimmed;
    if (payload.length === 0) {
      result.skipped += 1;
      continue;
    }

    intakeCapture({
      text: payload,
      source: "imessage",
      // ROWID is monotonic and unique, so a re-poll over the same range
      // updates rather than duplicating.
      externalId: `imessage:${row.ROWID}`,
    });
    result.captured += 1;
  }

  // Advance the cursor even when everything was skipped — otherwise a
  // single non-trigger message would be re-examined forever.
  if (result.lastRowid !== null && result.lastRowid !== since) {
    setSetting(LAST_ROWID_KEY, String(result.lastRowid));
  }
  void now;
  return result;
}

/**
 * Seed the cursor at the newest message without capturing anything.
 *
 * Run once when the channel is enabled. Without it, the first poll would
 * walk backwards through years of messages and file every one that ever
 * began with the trigger word — the "helpful" behaviour that would make
 * the user turn the feature off immediately.
 */
export function seedImessageCursor(): { ok: boolean; rowid: number | null } {
  try {
    const db = new Database(chatDbPath(), {
      readonly: true,
      fileMustExist: true,
    });
    try {
      const row = db
        .prepare("SELECT MAX(ROWID) AS rowid FROM message")
        .get() as { rowid: number | null } | undefined;
      const rowid = row?.rowid ?? null;
      if (rowid !== null) setSetting(LAST_ROWID_KEY, String(rowid));
      return { ok: true, rowid };
    } finally {
      db.close();
    }
  } catch {
    return { ok: false, rowid: null };
  }
}

export { appleDateToUnixSeconds };
