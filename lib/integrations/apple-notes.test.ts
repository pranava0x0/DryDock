import { describe, it, expect } from "vitest";
import {
  bodyToHtml,
  buildReadScript,
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
  it("lists matches first and only creates if no candidate is writable", () => {
    const script = buildWriteScript("MyNote", "<div>hi</div>");
    expect(script).toMatch(/every note whose name is "MyNote"/);
    expect(script).toMatch(/set didUpdate to false/);
    expect(script).toMatch(/set body of n to/);
    expect(script).toMatch(/if not didUpdate then/);
    expect(script).toMatch(/make new note/);
  });

  it("retries each candidate so -10000 / -1728 don't abort the sync", () => {
    const script = buildWriteScript("MyNote", "<div>hi</div>");
    expect(script).toMatch(/repeat with n in candidates/);
    expect(script).toMatch(/try[\s\S]*set body of n to[\s\S]*on error/);
    // We do NOT depend on the folder name "Recently Deleted" — that
    // approach broke when a candidate's container itself wouldn't
    // expose a `name`.
    expect(script).not.toMatch(/name of container/);
  });

  it("deletes additional writable candidates so future syncs converge", () => {
    // Before this fix, the loop `exit repeat`ed on the first writable
    // match. With multiple writable copies (left over from the V1 bug
    // or from a parallel dev server), each sync's non-deterministic
    // pick made it *look* like new notes were being created — the
    // existing ones kept rising to the top of the sidebar. The keeper
    // must now branch on didUpdate: first writable becomes the keeper,
    // every later writable gets `delete`d (soft delete to Recently
    // Deleted, restorable for 30 days).
    const script = buildWriteScript("MyNote", "<div>hi</div>");
    expect(script).toMatch(/if not didUpdate then[\s\S]*set body of n to/);
    expect(script).toMatch(/else[\s\S]*delete n/);
    // Crucially: no early `exit repeat`. We iterate the whole list so
    // every duplicate is caught in a single pass.
    expect(script).not.toMatch(/exit repeat/);
  });

  it("escapes embedded quotes and backslashes in the title and body", () => {
    const script = buildWriteScript('She said "hi"', 'C:\\path');
    // AppleScript literals: " becomes \" and \ becomes \\.
    expect(script).toContain('She said \\"hi\\"');
    expect(script).toContain("C:\\\\path");
  });
});

describe("buildReadScript", () => {
  it("filters trashed candidates so deleting the note doesn't auto-resurrect items", () => {
    // `first note whose name is X` matches notes in Recently Deleted
    // too, so the previous version silently pulled items from a
    // trashed copy and re-imported them. The new script must iterate
    // candidates and skip the trashed ones, returning "" if no
    // writable note exists.
    const script = buildReadScript("MyNote");
    expect(script).toMatch(/every note whose name is "MyNote"/);
    expect(script).toMatch(/repeat with n in candidates/);
    expect(script).toMatch(/name of container of n is "Recently Deleted"/);
    expect(script).toMatch(/if not isTrashed then return plaintext of n/);
    // No fallthrough to the deprecated `first note whose name is X`
    // shorthand — that's the bug we're fixing.
    expect(script).not.toMatch(/first note whose name/);
  });

  it("treats container-name-read failures as 'not trashed' (-1728 tolerance)", () => {
    // Some candidate containers don't expose a `name` and AppleScript
    // raises -1728. The check must be wrapped in a try so an
    // unreadable container doesn't abort the whole read.
    const script = buildReadScript("MyNote");
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
