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
 * Parse the body of an Apple Note into a list of backlog lines.
 *
 * We support two formats:
 *   - Markdown-ish checkboxes: `- [ ] do thing` / `- [x] do thing`
 *   - Plain bullets: `- do thing` (treated as un-done)
 *
 * Everything else is ignored, including blank lines and headings. This
 * keeps the user's preamble / notes in the note from getting promoted
 * to backlog items.
 */
export function parseAppleNote(body: string): AppleNoteLine[] {
  const out: AppleNoteLine[] = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    // Checkbox: `- [ ] text` or `- [x] text`.
    const cbMatch = line.match(/^-\s*\[([ xX])\]\s+(.+)$/);
    if (cbMatch) {
      const text = cbMatch[2].trim();
      if (text.length === 0) continue;
      out.push({
        externalId: lineId(text),
        done: cbMatch[1].toLowerCase() === "x",
        text,
      });
      continue;
    }

    // Plain bullet: `- text` (Apple Notes' native bullet rendering).
    const bulletMatch = line.match(/^[-•]\s+(.+)$/);
    if (bulletMatch) {
      const text = bulletMatch[1].trim();
      if (text.length === 0) continue;
      out.push({
        externalId: lineId(text),
        done: false,
        text,
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
 */
export interface RenderableItem {
  title: string;
  status: "idea" | "in_progress" | "done" | "dropped";
}

export function renderAppleNoteBody(items: RenderableItem[]): string {
  const lines = ["⚓ DryDock Backlog", ""];
  for (const item of items) {
    const checked = item.status === "done";
    lines.push(`- [${checked ? "x" : " "}] ${item.title}`);
  }
  return lines.join("\n");
}

/** Escape a string for safe interpolation inside an AppleScript literal. */
function asEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Read a note by title. Returns null if the note doesn't exist (so the
 * caller can create it on first sync).
 *
 * AppleScript's Notes interface uses `body` which is the HTML content;
 * we ask for `plaintext` so we can parse markdown-ish checkboxes
 * directly. iOS / iCloud Notes render `-` as a bullet, so the round-trip
 * still looks tidy to the user even though we're parsing plain text.
 */
export async function readAppleNote(
  title: string = DEFAULT_NOTE_TITLE,
): Promise<string | null> {
  const escTitle = asEscape(title);
  const script = `
    tell application "Notes"
      try
        set theNote to first note whose name is "${escTitle}"
        return plaintext of theNote
      on error
        return ""
      end try
    end tell
  `;
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
 * Create or overwrite a note's body. Uses HTML because Apple Notes
 * stores everything as HTML internally — passing plain text would
 * collapse all our newlines into one paragraph.
 */
export async function writeAppleNote(
  title: string,
  body: string,
): Promise<void> {
  const escTitle = asEscape(title);
  // Convert plain text → minimal HTML. Each line becomes a <div>, blank
  // lines become <div><br></div>. This mirrors how Apple Notes itself
  // serializes typed content, so the round-trip looks native.
  const htmlBody = body
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
  const escBody = asEscape(htmlBody);

  const script = `
    tell application "Notes"
      try
        set theNote to first note whose name is "${escTitle}"
        set body of theNote to "${escBody}"
      on error
        make new note with properties {name:"${escTitle}", body:"${escBody}"}
      end try
    end tell
  `;
  try {
    await execFileP("osascript", ["-e", script]);
  } catch (err) {
    throw new Error(`Apple Notes write failed: ${(err as Error).message}`);
  }
}
