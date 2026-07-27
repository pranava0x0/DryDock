import { describe, expect, it } from "vitest";
import {
  APPLE_EPOCH_OFFSET_S,
  appleDateToUnixSeconds,
  decodeAttributedBody,
} from "./typedstream";

/**
 * Fixtures are built to the exact framing observed in the real
 * `~/Library/Messages/chat.db` on this machine. The decoder was
 * cross-validated there against 4,000 messages that have BOTH `text` and
 * `attributedBody` — 4,000 exact matches, 0 mismatches — plus 4,000
 * decoded from the NULL-text half. These tests pin that framing so a
 * future format change fails loudly here rather than silently halving
 * the capture channel.
 */

/** Build a typedstream blob the way Messages does. */
function attributedBody(text: string, lengthStyle: "short" | "long" = "short") {
  const body = Buffer.from(text, "utf8");
  const header = Buffer.from("\x04\x0bstreamtyped", "binary");
  const classes = Buffer.from(
    "\x81\xe8\x03\x84\x01@\x84\x84\x84\x19NSMutableAttributedString\x00\x84\x84\x12NSAttributedString\x00\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84\x08NSString\x01\x95\x84\x01",
    "binary",
  );
  // '+' then the variable-width length.
  let lengthBytes: Buffer;
  if (lengthStyle === "long" || body.length > 0x80) {
    const b = Buffer.alloc(3);
    b[0] = 0x81;
    b.writeUInt16LE(body.length, 1);
    lengthBytes = b;
  } else {
    lengthBytes = Buffer.from([body.length]);
  }
  return new Uint8Array(
    Buffer.concat([header, classes, Buffer.from("+"), lengthBytes, body]),
  );
}

describe("decodeAttributedBody", () => {
  it("extracts a short message", () => {
    expect(decodeAttributedBody(attributedBody("idea: rate limit the tunnel")))
      .toBe("idea: rate limit the tunnel");
  });

  it("handles the 0x81 two-byte length escape", () => {
    // Anything over 128 bytes uses the escape; getting this wrong
    // truncates every long message to nothing.
    const long = "x".repeat(500);
    expect(decodeAttributedBody(attributedBody(long))).toBe(long);
  });

  it("round-trips multi-byte UTF-8", () => {
    // The length is in BYTES, not characters — reading it as characters
    // would slice mid-codepoint on any message with an emoji or a curly
    // quote, which is most of them.
    const text = 'Loved “I am totally fine” 🎉 café';
    expect(decodeAttributedBody(attributedBody(text))).toBe(text);
  });

  it("returns null rather than guessing when there's no NSString", () => {
    expect(decodeAttributedBody(new Uint8Array([1, 2, 3, 4]))).toBeNull();
    expect(decodeAttributedBody(new Uint8Array())).toBeNull();
    expect(decodeAttributedBody(null)).toBeNull();
  });

  it("returns null when the length runs past the buffer", () => {
    // A misread length must not slice arbitrary trailing bytes and
    // present them as a message.
    const blob = attributedBody("hello");
    const truncated = blob.subarray(0, blob.length - 3);
    expect(decodeAttributedBody(truncated)).toBeNull();
  });

  it("returns null on invalid UTF-8 rather than replacement characters", () => {
    // A string of U+FFFD looks like real text to everything downstream.
    const blob = attributedBody("hello");
    const corrupted = Uint8Array.from(blob);
    corrupted[corrupted.length - 1] = 0xff;
    corrupted[corrupted.length - 2] = 0xfe;
    expect(decodeAttributedBody(corrupted)).toBeNull();
  });

  it("rejects an absurd declared length", () => {
    const blob = Buffer.concat([
      Buffer.from("\x04\x0bstreamtyped", "binary"),
      Buffer.from("NSString", "binary"),
      Buffer.from([0x2b, 0x82, 0xff, 0xff, 0xff, 0x7f]),
      Buffer.from("hi"),
    ]);
    expect(decodeAttributedBody(new Uint8Array(blob))).toBeNull();
  });
});

describe("appleDateToUnixSeconds", () => {
  it("converts nanoseconds-since-2001 to Unix seconds", () => {
    // Read raw as Unix seconds, every message lands in 1970 and looks
    // 56 years old.
    const nanos = 800_000_000 * 1_000_000_000;
    expect(appleDateToUnixSeconds(nanos)).toBe(800_000_000 + APPLE_EPOCH_OFFSET_S);
  });

  it("handles the older seconds-based format by magnitude", () => {
    expect(appleDateToUnixSeconds(700_000_000)).toBe(
      700_000_000 + APPLE_EPOCH_OFFSET_S,
    );
  });

  it("returns null for junk", () => {
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(appleDateToUnixSeconds(bad)).toBeNull();
    }
    expect(appleDateToUnixSeconds("x" as unknown as number)).toBeNull();
  });
});
