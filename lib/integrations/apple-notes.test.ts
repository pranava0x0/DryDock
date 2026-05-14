import { describe, it, expect } from "vitest";
import {
  lineId,
  parseAppleNote,
  renderAppleNoteBody,
} from "./apple-notes";

describe("lineId", () => {
  it("is stable across calls and case-sensitive whitespace-insensitive trim only", () => {
    // Same content → same id even if the user re-saves the note.
    expect(lineId("buy milk")).toBe(lineId("  buy milk  "));
    // Different content → different id.
    expect(lineId("buy milk")).not.toBe(lineId("buy bread"));
    // Stable: first 16 hex chars.
    expect(lineId("buy milk")).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("parseAppleNote", () => {
  it("extracts un-checked checkbox items", () => {
    const body = `Header\n\n- [ ] do thing one\n- [ ] do thing two`;
    const items = parseAppleNote(body);
    expect(items).toHaveLength(2);
    expect(items[0].text).toBe("do thing one");
    expect(items[0].done).toBe(false);
    expect(items[1].text).toBe("do thing two");
  });

  it("detects checked items via [x] (lower or upper)", () => {
    const body = `- [x] done lowercase\n- [X] done uppercase`;
    const items = parseAppleNote(body);
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.done)).toBe(true);
  });

  it("accepts plain bullets (- or •) as un-done items", () => {
    const body = `- bullet one\n• bullet two`;
    const items = parseAppleNote(body);
    expect(items).toHaveLength(2);
    expect(items[0].text).toBe("bullet one");
    expect(items[1].text).toBe("bullet two");
    expect(items.every((i) => !i.done)).toBe(true);
  });

  it("ignores blank lines, prose, headings", () => {
    const body = `# Heading\n\nSome prose explaining the list.\n\n- [ ] actual item`;
    const items = parseAppleNote(body);
    expect(items).toHaveLength(1);
    expect(items[0].text).toBe("actual item");
  });

  it("produces stable external ids for identical text", () => {
    const a = parseAppleNote("- [ ] same line");
    const b = parseAppleNote("- [x] same line");
    expect(a[0].externalId).toBe(b[0].externalId);
    // But the done flag differs.
    expect(a[0].done).toBe(false);
    expect(b[0].done).toBe(true);
  });

  it("handles CRLF line endings (Apple Notes on iOS)", () => {
    const body = `- [ ] one\r\n- [x] two\r\n`;
    const items = parseAppleNote(body);
    expect(items.map((i) => ({ t: i.text, d: i.done }))).toEqual([
      { t: "one", d: false },
      { t: "two", d: true },
    ]);
  });
});

describe("renderAppleNoteBody", () => {
  it("includes a header and one checkbox per item", () => {
    const body = renderAppleNoteBody([
      { title: "first", status: "idea" },
      { title: "second", status: "done" },
      { title: "third", status: "in_progress" },
    ]);
    expect(body.startsWith("⚓ DryDock Backlog")).toBe(true);
    expect(body).toContain("- [ ] first");
    expect(body).toContain("- [x] second");
    // in_progress is treated as un-done in the note ("not yet finished").
    expect(body).toContain("- [ ] third");
  });

  it("round-trips: render → parse yields the original titles", () => {
    const items = [
      { title: "alpha", status: "idea" as const },
      { title: "beta", status: "done" as const },
    ];
    const body = renderAppleNoteBody(items);
    const parsed = parseAppleNote(body);
    expect(parsed.map((p) => p.text)).toEqual(["alpha", "beta"]);
    expect(parsed.map((p) => p.done)).toEqual([false, true]);
  });
});
