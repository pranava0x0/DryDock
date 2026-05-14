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
 * Build the AppleScript that returns the plaintext body of the first
 * non-trashed matching note (or empty string if no such note exists).
 * Pulled out alongside `buildWriteScript` so we can unit-test the
 * shape without shelling out.
 *
 * Why filter trashed notes on read too: `every note whose name is X`
 * returns notes from the Recently Deleted folder. The previous version
 * called `first note whose name is X` and would silently read from a
 * trashed copy — so deleting the note in Apple Notes to clear the
 * backlog actually re-imported all its content on the next sync.
 *
 * The `name of container` check is wrapped in `try` because some
 * candidates' containers don't respond to `name` (`-1728`). When we
 * can't determine the container, we treat the note as non-trashed and
 * use it — the write path will catch and skip it if it's actually
 * unwritable.
 */
export function buildReadScript(title: string): string {
  const escTitle = asEscape(title);
  return `
    tell application "Notes"
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
 * AppleScript's Notes interface uses `body` which is the HTML content;
 * we ask for `plaintext` so we can parse markdown-ish checkboxes
 * directly. iOS / iCloud Notes render `-` as a bullet, so the round-trip
 * still looks tidy to the user even though we're parsing plain text.
 */
export async function readAppleNote(
  title: string = DEFAULT_NOTE_TITLE,
): Promise<string | null> {
  const script = buildReadScript(title);
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
 * Build the AppleScript that finds-or-creates the canonical DryDock note
 * and replaces its body. Pulled out so we can unit-test the shape of the
 * script without shelling out — and to make the find/create logic
 * obvious in one place.
 *
 * Design history:
 *
 *   1. The first version used `first note whose name is X` inside a
 *      single try/on-error block; any transient AppleScript error fell
 *      through to `make new note` and silently created a duplicate.
 *
 *   2. The second version filtered candidates by
 *      `name of container is not "Recently Deleted"`. That broke when a
 *      candidate's container didn't respond to `name` (`-1728`).
 *
 *   3. The third version tried each candidate's `set body` directly,
 *      `exit repeat`-ing on the first success. Fixed the create-on-
 *      every-error problem, but left existing duplicates in place. Each
 *      sync touched *some* writable duplicate (AppleScript's
 *      enumeration order is non-deterministic), so different copies
 *      kept rising to the top of the sidebar — visually indistinguish-
 *      able from "still creating new notes on every sync."
 *
 *   4. (Current) Active deduplication. After the first successful
 *      `set body`, every other writable candidate gets `delete`d —
 *      moved to Recently Deleted, where the user can restore from for
 *      30 days. Future syncs converge to a single canonical note. We
 *      keep going through the loop instead of `exit repeat`ing so we
 *      catch every duplicate in one pass.
 *
 * Apple's `delete note` is a soft delete — the note lands in Recently
 * Deleted and survives 30 days, so the action is reversible if a user
 * happens to have created their own unrelated "DryDock Backlog" note
 * we end up trashing. The title match is intentionally strict.
 */
export function buildWriteScript(title: string, htmlBody: string): string {
  const escTitle = asEscape(title);
  const escBody = asEscape(htmlBody);
  return `
    tell application "Notes"
      set candidates to every note whose name is "${escTitle}"
      set didUpdate to false
      repeat with n in candidates
        try
          if not didUpdate then
            set body of n to "${escBody}"
            set didUpdate to true
          else
            -- Another writable note with the same name exists. Move it
            -- to Recently Deleted so future syncs converge to a single
            -- canonical note. Soft delete — restorable for 30 days.
            delete n
          end if
        on error
          -- Skip notes we can't write (Recently Deleted raises -10000,
          -- locked-account notes raise other codes). The keeper-or-
          -- delete decision only applies to writable matches.
        end try
      end repeat
      if not didUpdate then
        make new note with properties {name:"${escTitle}", body:"${escBody}"}
      end if
    end tell
  `;
}

/**
 * Create or overwrite the canonical DryDock note's body. Uses HTML
 * because Apple Notes stores everything as HTML internally — passing
 * plain text would collapse all our newlines into one paragraph.
 *
 * If two notes with the same title already exist (e.g. left over from
 * the previous version's duplicate-create bug), we update the first
 * match and leave the rest alone. Future cleanup is a manual one-time
 * task in the Notes app.
 */
export async function writeAppleNote(
  title: string,
  body: string,
): Promise<void> {
  const script = buildWriteScript(title, bodyToHtml(body));
  try {
    await execFileP("osascript", ["-e", script]);
  } catch (err) {
    throw new Error(`Apple Notes write failed: ${(err as Error).message}`);
  }
}
