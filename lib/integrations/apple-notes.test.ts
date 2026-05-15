import { describe, it, expect } from "vitest";
import {
  bodyToHtml,
  buildReadScript,
  buildWriteScript,
  DEFAULT_NOTE_TITLE,
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

  it("first line equals DEFAULT_NOTE_TITLE so it matches Apple Notes' auto-derived name", () => {
    // Apple Notes ignores the `name` we pass to `make new note` and
    // derives the note's name from the body's first non-empty line.
    // If those two strings diverge, our by-name search (which uses
    // DEFAULT_NOTE_TITLE) finds zero candidates and the fallback path
    // creates a fresh note on every sync. Pin them to the same value.
    const body = renderAppleNoteBody([{ title: "x", status: "idea" }]);
    expect(body.split("\n")[0]).toBe(DEFAULT_NOTE_TITLE);
  });

  it("includes the anchor emoji in the default title so iCloud names match", () => {
    // Regression for the V5 "still creating new notes" bug: by-name
    // search for "DryDock Backlog" (no anchor) matched 0 of 10
    // existing notes named "⚓ DryDock Backlog" in iCloud.
    expect(DEFAULT_NOTE_TITLE).toBe("⚓ DryDock Backlog");
  });

  it("honors a custom title so a renamed note's body still matches by name", () => {
    const body = renderAppleNoteBody(
      [{ title: "x", status: "idea" }],
      "My Custom Title",
    );
    expect(body.split("\n")[0]).toBe("My Custom Title");
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

  it("returns createdAt parsed from the suffix as Unix seconds", () => {
    const parsed = parseAppleNote("- [ ] dated · added 2026-05-14");
    expect(parsed[0].createdAt).not.toBeNull();
    // Round-trip via formatAddedDate to dodge timezone surprises (the
    // formatter and parser both use local time at noon).
    expect(formatAddedDate(parsed[0].createdAt!)).toBe("2026-05-14");
  });

  it("returns null createdAt when there is no parseable suffix", () => {
    const parsed = parseAppleNote("- [ ] no date here");
    expect(parsed[0].createdAt).toBeNull();
  });

  it("returns null createdAt for invalid dates (e.g. 2026-99-99)", () => {
    // JS Date rolls invalid month/day silently — guard via round-trip
    // sanity check so a malformed suffix doesn't mint a wildly-off
    // timestamp on the created backlog row.
    const parsed = parseAppleNote("- [ ] junk · added 2026-99-99");
    expect(parsed[0].createdAt).toBeNull();
    // The text retains the suffix because the regex didn't match
    // (\d{2} caps month/day at two digits, so 99 still matches, but
    // the round-trip check kicks in afterward — text-strip still
    // happens). Verify the text is whatever the regex stripped.
    expect(parsed[0].text).toBe("junk");
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
    expect(parsed[0].createdAt).toBeNull();
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
  it("targets the stored note id first, before falling back to by-name search", () => {
    // V5: the steady-state path. After the first successful sync we
    // persist the note's stable id; subsequent writes hit it directly
    // and never enumerate by name, which is what made V3 look like it
    // was rotating through duplicates.
    const script = buildWriteScript("MyNote", "<div>hi</div>", "x-coredata://abc/ICNote/p1");
    expect(script).toMatch(
      /set targetNote to note id "x-coredata:\/\/abc\/ICNote\/p1"/,
    );
    expect(script).toMatch(/set body of targetNote to/);
    expect(script).toMatch(/return id of targetNote/);
  });

  it("falls back to find-writable-by-name when no id is stored", () => {
    const script = buildWriteScript("MyNote", "<div>hi</div>", null);
    // Empty id literal — the script's `if "" is not ""` guard skips
    // the id branch entirely on the first ever sync.
    expect(script).toMatch(/if "" is not ""/);
    expect(script).toMatch(/every note whose name is "MyNote"/);
    expect(script).toMatch(/repeat with n in candidates/);
    expect(script).toMatch(/return id of n/);
  });

  it("returns the id of a freshly-created note when no candidate is writable", () => {
    const script = buildWriteScript("MyNote", "<div>hi</div>", null);
    expect(script).toMatch(/make new note with properties/);
    expect(script).toMatch(/return id of newNote/);
  });

  it("never deletes existing notes (the user asked us to edit, not trash)", () => {
    // V4 actively `delete`d duplicate writable matches. The user
    // pushed back: duplicates should be left alone, we just need to
    // consistently edit one specific note. The id-stable approach
    // accomplishes that without ever trashing user data — regression
    // pin so a future refactor doesn't reintroduce delete.
    const idScript = buildWriteScript("MyNote", "<div>hi</div>", "abc");
    const noIdScript = buildWriteScript("MyNote", "<div>hi</div>", null);
    expect(idScript).not.toMatch(/delete /);
    expect(noIdScript).not.toMatch(/delete /);
  });

  it("retries through candidates so -10000 / -1728 don't abort the sync", () => {
    // Trashed-note candidates raise -10000; containers without a
    // `name` raise -1728. The loop must swallow per-candidate errors.
    const script = buildWriteScript("MyNote", "<div>hi</div>", null);
    expect(script).toMatch(/try[\s\S]*set body of n to[\s\S]*end try/);
  });

  it("escapes embedded quotes and backslashes in the title, body, and id", () => {
    const script = buildWriteScript('She said "hi"', 'C:\\path', 'id"with\\stuff');
    expect(script).toContain('She said \\"hi\\"');
    expect(script).toContain("C:\\\\path");
    expect(script).toContain('id\\"with\\\\stuff');
  });
});

describe("buildReadScript", () => {
  it("hits the stored note id directly when one is provided", () => {
    const script = buildReadScript("MyNote", "x-coredata://abc/ICNote/p1");
    expect(script).toMatch(
      /plaintext of \(note id "x-coredata:\/\/abc\/ICNote\/p1"\)/,
    );
  });

  it("filters trashed candidates on the by-name fallback path", () => {
    // First-ever sync has no stored id, so we must still skip trashed
    // matches — otherwise deleting the note in Apple Notes to clear
    // the backlog silently re-imports its content on the next sync.
    const script = buildReadScript("MyNote", null);
    expect(script).toMatch(/every note whose name is "MyNote"/);
    expect(script).toMatch(/repeat with n in candidates/);
    expect(script).toMatch(/name of container of n is "Recently Deleted"/);
    expect(script).toMatch(/if not isTrashed then return plaintext of n/);
    expect(script).not.toMatch(/first note whose name/);
  });

  it("treats container-name-read failures as 'not trashed' (-1728 tolerance)", () => {
    const script = buildReadScript("MyNote", null);
    expect(script).toMatch(/try[\s\S]*name of container[\s\S]*end try/);
    expect(script).toMatch(/set isTrashed to false/);
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
