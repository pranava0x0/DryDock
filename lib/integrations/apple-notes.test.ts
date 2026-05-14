import { describe, it, expect } from "vitest";
import {
  bodyToHtml,
  buildWriteScript,
  formatAddedDate,
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

  it("appends ' · added YYYY-MM-DD' when createdAt is set", () => {
    // 2026-05-14 in the host TZ — formatAddedDate uses local time on
    // purpose (see its docstring), so we derive the expected date from
    // the same helper instead of hard-coding a UTC date that would be
    // off-by-one in non-UTC timezones.
    const ts = Math.floor(new Date(2026, 4, 14, 12).getTime() / 1000);
    const body = renderAppleNoteBody([
      { title: "with date", status: "idea", createdAt: ts },
    ]);
    expect(body).toContain(`- [ ] with date · added ${formatAddedDate(ts)}`);
  });

  it("omits the suffix when createdAt is missing or non-finite", () => {
    const body = renderAppleNoteBody([
      { title: "no-date", status: "idea" },
      { title: "nan-date", status: "idea", createdAt: Number.NaN },
    ]);
    expect(body).toContain("- [ ] no-date\n");
    expect(body).toContain("- [ ] nan-date");
    expect(body).not.toMatch(/added (NaN|undefined)/);
  });
});

describe("parseAppleNote with added-date suffix", () => {
  it("strips the ' · added YYYY-MM-DD' suffix before hashing externalId", () => {
    const withSuffix = parseAppleNote("- [ ] do thing · added 2026-05-14");
    const without = parseAppleNote("- [ ] do thing");
    expect(withSuffix[0].text).toBe("do thing");
    // Stable line-key: a re-render with a newer date must not mint a
    // duplicate backlog row on the next pull.
    expect(withSuffix[0].externalId).toBe(without[0].externalId);
  });

  it("round-trips items with createdAt without changing externalId", () => {
    const ts1 = Math.floor(Date.UTC(2026, 0, 1) / 1000);
    const ts2 = Math.floor(Date.UTC(2026, 4, 14) / 1000);
    const first = parseAppleNote(
      renderAppleNoteBody([
        { title: "shared title", status: "idea", createdAt: ts1 },
      ]),
    );
    const second = parseAppleNote(
      renderAppleNoteBody([
        { title: "shared title", status: "idea", createdAt: ts2 },
      ]),
    );
    expect(first[0].externalId).toBe(second[0].externalId);
    expect(first[0].text).toBe("shared title");
  });

  it("leaves unrecognized date-ish suffixes intact", () => {
    // The strict YYYY-MM-DD pattern keeps us from eating user content
    // that happens to mention "added" — only the precise format we
    // emit gets removed.
    const parsed = parseAppleNote("- [ ] item · added yesterday");
    expect(parsed[0].text).toBe("item · added yesterday");
  });
});

describe("formatAddedDate", () => {
  it("zero-pads month and day", () => {
    const ts = Math.floor(new Date(2026, 0, 5, 12).getTime() / 1000);
    expect(formatAddedDate(ts)).toBe("2026-01-05");
  });

  it("returns YYYY-MM-DD shape", () => {
    expect(formatAddedDate(Math.floor(Date.now() / 1000))).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
  });
});

describe("buildWriteScript", () => {
  it("branches on `count of matches` instead of using on-error fallback", () => {
    const script = buildWriteScript("MyNote", "<div>hi</div>");
    // The duplicate-note bug came from an `on error -> make new note`
    // catch-all; we explicitly forbid that pattern here so a future
    // refactor can't reintroduce it.
    expect(script).not.toMatch(/on error/);
    expect(script).toMatch(/every note whose name is "MyNote"/);
    expect(script).toMatch(/count of matches/);
    expect(script).toMatch(/if \(count of matches\) is 0/);
    // Both branches present.
    expect(script).toMatch(/make new note/);
    expect(script).toMatch(/set body of \(item 1 of matches\)/);
  });

  it("escapes embedded quotes and backslashes in the title and body", () => {
    const script = buildWriteScript('She said "hi"', 'C:\\path');
    // AppleScript literals: " becomes \" and \ becomes \\.
    expect(script).toContain('She said \\"hi\\"');
    expect(script).toContain("C:\\\\path");
  });
});

describe("bodyToHtml", () => {
  it("preserves blank lines as <div><br></div> and escapes HTML", () => {
    const html = bodyToHtml("line one\n\n<b>bold?</b>");
    expect(html).toContain("<div>line one</div>");
    expect(html).toContain("<div><br></div>");
    // < and > are escaped so the rendered note shows literal text rather
    // than executing the user's HTML.
    expect(html).toContain("&lt;b&gt;bold?&lt;/b&gt;");
  });
});
