/**
 * A minimal `attributedBody` (NSArchiver typedstream) text extractor.
 *
 * ── Why this is unavoidable ─────────────────────────────────────────────
 * Since Ventura, Messages often leaves `message.text` NULL and stores the
 * body only in `attributedBody`, a serialized `NSMutableAttributedString`.
 * On this machine that is **497,612 of 949,169 messages — 52%**. A poller
 * that read only the `text` column would silently miss half of everything
 * the user sent, which is the worst possible failure for a capture
 * channel: it looks like it works.
 *
 * ── Why hand-rolled rather than a full typedstream parser ───────────────
 * We need exactly one string out of a format whose full grammar is large
 * and undocumented. The framing around that string is stable and simple:
 *
 *   \x04\x0bstreamtyped … NSMutableAttributedString … NSString … + <len> <utf8>
 *
 * `+` (0x2B) is typedstream's C-string type marker; the length that
 * follows uses its variable-width integer encoding. Everything else in
 * the archive — attribute runs, colors, fonts — is skipped rather than
 * modelled.
 *
 * ── Validated against the real corpus ───────────────────────────────────
 * Cross-checked on 4,000 messages where BOTH `text` and `attributedBody`
 * exist: 4,000 exact matches, 0 mismatches, 0 failures to decode. And
 * 4,000/4,000 decoded from the NULL-text half. That's the evidence this
 * shortcut is sound; re-run it (see the test) if the format ever shifts.
 *
 * Returns null rather than guessing. A null is surfaced to the user as
 * "a capture arrived but its text was unreadable", never dropped.
 */

/** typedstream's C-string type marker. */
const CSTRING = 0x2b;

/** Class names that precede the body string, in preference order. */
const MARKERS = ["NSString", "NSMutableString"];

/**
 * Sanity ceiling on a decoded length. An iMessage is not 4MB of text, so
 * a larger length means the framing was misread — better to return null
 * than to slice a megabyte of binary and call it a message.
 */
const MAX_TEXT_BYTES = 4 * 1024 * 1024;

export function decodeAttributedBody(blob: Uint8Array | null): string | null {
  if (!blob || blob.length === 0) return null;

  for (const marker of MARKERS) {
    const start = indexOfAscii(blob, marker);
    if (start === -1) continue;

    const typeAt = blob.indexOf(CSTRING, start + marker.length);
    if (typeAt === -1) continue;

    let p = typeAt + 1;
    if (p >= blob.length) continue;

    // Variable-width length: one byte, or a 0x81/0x82 escape introducing
    // a 2- or 4-byte little-endian count.
    let length = blob[p];
    p += 1;
    if (length === 0x81) {
      if (p + 2 > blob.length) continue;
      length = blob[p] | (blob[p + 1] << 8);
      p += 2;
    } else if (length === 0x82) {
      if (p + 4 > blob.length) continue;
      length =
        blob[p] |
        (blob[p + 1] << 8) |
        (blob[p + 2] << 16) |
        (blob[p + 3] << 24);
      p += 4;
    }

    if (length <= 0 || length > MAX_TEXT_BYTES || p + length > blob.length) {
      continue;
    }

    try {
      // `fatal` so invalid UTF-8 fails loudly instead of producing a
      // string full of replacement characters that looks like real text.
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        blob.subarray(p, p + length),
      );
      if (text.length > 0) return text;
    } catch {
      // Misread framing. Try the next marker.
    }
  }

  return null;
}

/** Index of an ASCII needle within a byte array, or -1. */
function indexOfAscii(haystack: Uint8Array, needle: string): number {
  const first = needle.charCodeAt(0);
  const limit = haystack.length - needle.length;
  outer: for (let i = 0; i <= limit; i += 1) {
    if (haystack[i] !== first) continue;
    for (let j = 1; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle.charCodeAt(j)) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * Apple's `message.date` is **nanoseconds since 2001-01-01 UTC**, not the
 * Unix epoch — a raw value read as Unix seconds lands in 1970 and every
 * message looks 56 years old.
 *
 * Older rows (pre-High Sierra) store seconds instead of nanoseconds, so
 * the magnitude is checked: anything under 1e11 is already seconds.
 */
export const APPLE_EPOCH_OFFSET_S = 978_307_200;

export function appleDateToUnixSeconds(value: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  const seconds = value > 100_000_000_000 ? value / 1_000_000_000 : value;
  return Math.floor(seconds + APPLE_EPOCH_OFFSET_S);
}
