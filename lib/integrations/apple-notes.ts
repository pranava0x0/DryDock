import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

const execFileP = promisify(execFile);

/**
 * Apple Notes integration via osascript.
 *
 * Strictly Mac-only — DryDock is designed to run on the user's host Mac
 * and shell out to Apple's automation interface. There's no service to
 * pay for, no API key, no third-party dependency. Cost: free.
 *
 * Sync model: ONE canonical note (default title "DryDock Backlog") that
 * the DryDock UI and the user's Apple Notes app both edit. We push DB
 * state to the note on every backlog mutation; we pull from the note
 * only when the user explicitly hits the Sync button. That avoids a
 * polling loop and keeps the note from getting rewritten while the user
 * is mid-edit.
 *
 * Conflict resolution on pull:
 *   - Items with a stable line key (`external_id`) already in the DB are
 *     updated in place if the note's content has changed.
 *   - New checkboxes in the note become new backlog items with
 *     source='apple-notes'.
 *   - DB items that are no longer present in the note are left alone
 *     (assume the user deleted them on iCloud — they get added back on
 *     the next push). To actually drop an item, use the DryDock UI.
 *
 * The format we render to the note is intentionally plain so the user
 * can edit it natively on iOS without breaking parsing.
 */

export const DEFAULT_NOTE_TITLE = "DryDock Backlog";

export interface AppleNoteLine {
  /** Stable hash of the original line text. Used as backlog.external_id. */
  externalId: string;
  /** Whether the user has checked the checkbox / marked the item done. */
  done: boolean;
  /** The user's free-form text minus the leading marker. */
  text: string;
  /**
   * Unix-seconds creation timestamp extracted from the ` · added YYYY-MM-DD`
   * suffix the renderer appends. Null when the line had no parseable
   * suffix — for those, the orchestrator falls back to `unixepoch()` on
   * INSERT (the user typed the line natively and never had a date).
   */
  createdAt: number | null;
}

/**
 * Stable id for a backlog line. We hash the trimmed text so that
 * re-ordering the note or re-syncing doesn't create duplicates. Two
 * items with identical text will collide — that's acceptable (and rare).
 */
export function lineId(text: string): string {
  return createHash("sha1")
    .update(text.trim())
    .digest("hex")
    .slice(0, 16);
}

/**
 * Trailing ` · added YYYY-MM-DD` suffix the renderer appends so the user
 * can see when each item entered the backlog. Stripped before computing
 * `externalId` so the line key stays stable across re-renders (the
 * timestamp text would otherwise change the hash on every push). The
 * captured date also lets a DB rebuild from a note preserve the original
 * `created_at` — without that, every wipe-and-resync would stamp items
 * with today's date and the user's "added" history would silently reset.
 */
const ADDED_SUFFIX_RE = / · added (\d{4})-(\d{2})-(\d{2})$/;

interface ParsedSuffix {
  stripped: string;
  createdAt: number | null;
}

function parseAddedSuffix(text: string): ParsedSuffix {
  const match = text.match(ADDED_SUFFIX_RE);
  if (!match) return { stripped: text.trim(), createdAt: null };
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  // Local-time noon — mirror formatAddedDate's choice of timezone and
  // avoid DST boundary surprises that midnight could trip.
  const d = new Date(year, month - 1, day, 12, 0, 0, 0);
  const stripped = text.replace(ADDED_SUFFIX_RE, "").trim();
  // Guard against degenerate inputs (e.g. 2026-99-99) — Date silently
  // rolls those over, so we sanity-check the round-trip.
  if (
    d.getFullYear() !== year ||
    d.getMonth() !== month - 1 ||
    d.getDate() !== day
  ) {
    return { stripped, createdAt: null };
  }
  return { stripped, createdAt: Math.floor(d.getTime() / 1000) };
}

/**
 * Parse the body of an Apple Note into a list of backlog lines.
 *
 * We support two formats:
 *   - Markdown-ish checkboxes: `- [ ] do thing` / `- [x] do thing`
 *   - Plain bullets: `- do thing` (treated as un-done)
 *
 * Everything else is ignored, including blank lines and headings. This
 * keeps the user's preamble / notes in the note from getting promoted
 * to backlog items.
 *
 * The renderer's ` · added YYYY-MM-DD` suffix is stripped before the
 * line is hashed into `externalId` so a push/pull round-trip is stable
 * even though `created_at` is rendered each time.
 */
export function parseAppleNote(body: string): AppleNoteLine[] {
  const out: AppleNoteLine[] = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    // Checkbox: `- [ ] text` or `- [x] text`.
    const cbMatch = line.match(/^-\s*\[([ xX])\]\s+(.+)$/);
    if (cbMatch) {
      const { stripped, createdAt } = parseAddedSuffix(cbMatch[2]);
      if (stripped.length === 0) continue;
      out.push({
        externalId: lineId(stripped),
        done: cbMatch[1].toLowerCase() === "x",
        text: stripped,
        createdAt,
      });
      continue;
    }

    // Plain bullet: `- text` (Apple Notes' native bullet rendering).
    const bulletMatch = line.match(/^[-•]\s+(.+)$/);
    if (bulletMatch) {
      const { stripped, createdAt } = parseAddedSuffix(bulletMatch[1]);
      if (stripped.length === 0) continue;
      out.push({
        externalId: lineId(stripped),
        done: false,
        text: stripped,
        createdAt,
      });
    }
  }
  return out;
}

/**
 * Render a list of backlog items as the Apple Note body. Mirrors the
 * markdown-checkbox shape so the round-trip is lossless.
 *
 * Header line + blank line gives the user a place to type their own
 * notes without them being parsed as backlog items.
 *
 * When `createdAt` is set we append ` · added YYYY-MM-DD` so the user
 * can see the age of each item in their note. The parser strips this
 * suffix before computing `externalId`, so re-renders don't mint new
 * backlog rows on every push.
 */
export interface RenderableItem {
  title: string;
  status: "idea" | "in_progress" | "done" | "dropped";
  /** Unix-seconds creation timestamp from `backlog_items.created_at`. */
  createdAt?: number;
}

/**
 * Format a Unix-seconds timestamp as `YYYY-MM-DD` in the host's local
 * timezone. The host is the user's Mac, so local time is the right frame
 * — the user thinks about "yesterday" / "Monday" in their own timezone,
 * not UTC.
 */
export function formatAddedDate(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function renderAppleNoteBody(items: RenderableItem[]): string {
  const lines = ["⚓ DryDock Backlog", ""];
  for (const item of items) {
    const checked = item.status === "done";
    const suffix =
      typeof item.createdAt === "number" && Number.isFinite(item.createdAt)
        ? ` · added ${formatAddedDate(item.createdAt)}`
        : "";
    lines.push(`- [${checked ? "x" : " "}] ${item.title}${suffix}`);
  }
  return lines.join("\n");
}

/** Escape a string for safe interpolation inside an AppleScript literal. */
function asEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Build the AppleScript that returns the plaintext body of the canonical
 * DryDock note (or empty string if none exists).
 *
 * Same selection order as `buildWriteScript`:
 *   1. If `knownId` is set, look the note up by id directly.
 *   2. Otherwise iterate matches by name and skip trashed ones.
 *
 * Filtering trashed notes on read matters too — without it, deleting
 * the note in Apple Notes to clear the backlog silently re-imports all
 * its content on the next sync because `first note whose name is X`
 * still returns the trashed copy.
 *
 * `name of container` is wrapped in `try` because some candidates'
 * containers don't respond to `name` (`-1728`). When we can't
 * determine the container, we treat the note as non-trashed and use
 * it — the write path will catch and skip it if it's actually
 * unwritable.
 */
export function buildReadScript(
  title: string,
  knownId: string | null = null,
): string {
  const escTitle = asEscape(title);
  const escId = asEscape(knownId ?? "");
  return `
    tell application "Notes"
      if "${escId}" is not "" then
        try
          return plaintext of (note id "${escId}")
        end try
      end if
      set candidates to every note whose name is "${escTitle}"
      repeat with n in candidates
        set isTrashed to false
        try
          if name of container of n is "Recently Deleted" then set isTrashed to true
        end try
        if not isTrashed then return plaintext of n
      end repeat
      return ""
    end tell
  `;
}

/**
 * Read the canonical DryDock note. Returns null if no non-trashed note
 * with the title exists — the caller (sync) creates one on first push.
 *
 * Pass `knownId` (the persisted Apple Notes id from a previous write)
 * to short-circuit the title lookup and read the exact same note we
 * last wrote to. If that id is stale (note deleted) we fall back to
 * the by-name path inside the script.
 *
 * AppleScript's Notes interface uses `body` which is the HTML content;
 * we ask for `plaintext` so we can parse markdown-ish checkboxes
 * directly. iOS / iCloud Notes render `-` as a bullet, so the round-trip
 * still looks tidy to the user even though we're parsing plain text.
 */
export async function readAppleNote(
  title: string = DEFAULT_NOTE_TITLE,
  knownId: string | null = null,
): Promise<string | null> {
  const script = buildReadScript(title, knownId);
  try {
    const { stdout } = await execFileP("osascript", ["-e", script]);
    const body = stdout.trimEnd();
    return body.length === 0 ? null : body;
  } catch (err) {
    // osascript exits non-zero when Notes isn't authorized — surface the
    // message verbatim so the user knows what to fix in System Settings.
    throw new Error(`Apple Notes read failed: ${(err as Error).message}`);
  }
}

/**
 * Convert our plain-text note body into the minimal HTML Apple Notes
 * stores internally. Each line becomes a <div>, blank lines become
 * <div><br></div>, so the round-trip looks identical to natively-typed
 * content. Exported for tests; not part of the public surface.
 */
export function bodyToHtml(body: string): string {
  return body
    .split("\n")
    .map((line) =>
      line.length === 0
        ? "<div><br></div>"
        : `<div>${line
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")}</div>`,
    )
    .join("");
}

/**
 * Build the AppleScript that updates the canonical DryDock note's body
 * and returns its stable Apple Notes id (e.g.
 * `x-coredata://UUID/ICNote/p297`) on stdout. Pulled out so we can
 * unit-test the shape without shelling out.
 *
 * Selection order — the script tries each branch and returns on the
 * first success:
 *
 *   1. **Known id** (`knownId` non-empty). `set body of note id "..."`
 *      targets one specific note regardless of name collisions. This
 *      is the steady-state path once the first successful sync has
 *      stored an id. Catches `note id` lookup failures (deleted,
 *      Recently Deleted) and falls through.
 *
 *   2. **Find writable by name.** `every note whose name is X` returns
 *      every candidate (including Recently Deleted); we iterate and
 *      use the first one whose `set body` succeeds. AppleScript's
 *      enumeration order isn't deterministic, but once a candidate is
 *      picked its id gets stored and the next sync uses branch 1.
 *
 *   3. **Create.** `make new note` only runs when no writable
 *      candidate exists — never as a fallback for transient errors,
 *      which was the V1 duplicate-note bug.
 *
 * Returning the id lets the caller persist it so subsequent syncs
 * lock onto the same note. Without this, V3/V4 picked a different
 * writable duplicate on each sync (and V4 trashed the rest); V5
 * leaves duplicates untouched and targets one specific note for life.
 */
export function buildWriteScript(
  title: string,
  htmlBody: string,
  knownId: string | null = null,
): string {
  const escTitle = asEscape(title);
  const escBody = asEscape(htmlBody);
  const escId = asEscape(knownId ?? "");
  return `
    tell application "Notes"
      if "${escId}" is not "" then
        try
          set targetNote to note id "${escId}"
          set body of targetNote to "${escBody}"
          return id of targetNote
        end try
      end if
      set candidates to every note whose name is "${escTitle}"
      repeat with n in candidates
        try
          set body of n to "${escBody}"
          return id of n
        end try
      end repeat
      set newNote to make new note with properties {name:"${escTitle}", body:"${escBody}"}
      return id of newNote
    end tell
  `;
}

/**
 * Create or overwrite the canonical DryDock note's body. Uses HTML
 * because Apple Notes stores everything as HTML internally — passing
 * plain text would collapse all our newlines into one paragraph.
 *
 * Pass `knownId` to target a specific note regardless of name (the
 * persisted Apple Notes id from a previous write). When the script
 * succeeds it returns the id of the note it ended up writing to —
 * either `knownId`, a found-by-name match, or a freshly-created note.
 * The caller persists that id so the next sync hits the same note
 * even if the user has multiple "DryDock Backlog" copies.
 *
 * Returns null if the script ran but didn't yield a usable id (should
 * not happen in practice; included for type-safety on the caller).
 */
export async function writeAppleNote(
  title: string,
  body: string,
  knownId: string | null = null,
): Promise<string | null> {
  const script = buildWriteScript(title, bodyToHtml(body), knownId);
  try {
    const { stdout } = await execFileP("osascript", ["-e", script]);
    const id = stdout.trim();
    return id.length === 0 ? null : id;
  } catch (err) {
    throw new Error(`Apple Notes write failed: ${(err as Error).message}`);
  }
}
