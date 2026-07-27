import { describe, expect, it } from "vitest";
import {
  findDuplicates,
  matchProject,
  parseCapture,
  SIMILARITY_THRESHOLD,
  slugify,
  titleSimilarity,
} from "./capture";

const PROJECTS = [
  { id: "p1", name: "DryDock" },
  { id: "p2", name: "Robotics Leadership" },
  { id: "p3", name: "FirstPassRx" },
  { id: "p4", name: "ppa-helper" },
];

describe("parseCapture — markers", () => {
  it("keeps plain text as the title, with no markers", () => {
    const parsed = parseCapture("rate limiter for the tunnel endpoints");
    expect(parsed.title).toBe("rate limiter for the tunnel endpoints");
    expect(parsed.priority).toBe(0);
    expect(parsed.projectMarker).toBeNull();
  });

  it("strips trailing priority and project markers", () => {
    const parsed = parseCapture(
      "rate limiter for the tunnel endpoints p2 #drydock",
      PROJECTS,
    );
    expect(parsed.title).toBe("rate limiter for the tunnel endpoints");
    expect(parsed.priority).toBe(2);
    expect(parsed.projectId).toBe("p1");
  });

  it("accepts the markers in either order", () => {
    const a = parseCapture("thing #drydock p1", PROJECTS);
    const b = parseCapture("thing p1 #drydock", PROJECTS);
    expect(a.title).toBe("thing");
    expect(b.title).toBe("thing");
    expect(a.priority).toBe(3);
    expect(b.priority).toBe(3);
  });

  it("maps p1 to the HIGHEST priority value", () => {
    // priority sorts DESC, so p1 (most urgent) must be the largest
    // number. Inverting this would file every urgent capture at the
    // bottom of the list — the one failure a capture channel can't
    // survive.
    expect(parseCapture("x p1").priority).toBe(3);
    expect(parseCapture("x p4").priority).toBe(0);
    expect(parseCapture("x p1").priority).toBeGreaterThan(
      parseCapture("x p3").priority,
    );
  });

  it("only reads markers as a trailing suffix", () => {
    // "fix the #2 bug in p1 mode" is a title, not a project called "2".
    const parsed = parseCapture("fix the #2 bug in p1 mode", PROJECTS);
    expect(parsed.title).toBe("fix the #2 bug in p1 mode");
    expect(parsed.priority).toBe(0);
  });

  it("keeps an unmatched project marker visible instead of dropping it", () => {
    const parsed = parseCapture("thing #nosuchproject", PROJECTS);
    expect(parsed.projectId).toBeNull();
    expect(parsed.projectMarker).toBe("nosuchproject");
  });

  it("never produces an empty title", () => {
    // A capture that is only markers still meant something.
    const parsed = parseCapture("p1 #drydock", PROJECTS);
    expect(parsed.title.length).toBeGreaterThan(0);
    expect(parsed.title).toBe("p1 #drydock");
  });

  it("survives garbage without throwing", () => {
    for (const bad of ["", "   ", "###", "p9", "#"]) {
      const parsed = parseCapture(bad, PROJECTS);
      expect(typeof parsed.title).toBe("string");
      expect(parsed.raw).toBe(bad);
    }
  });

  it("always preserves the raw text verbatim", () => {
    const raw = "  rate limiter p2 #drydock  ";
    expect(parseCapture(raw, PROJECTS).raw).toBe(raw);
  });
});

describe("matchProject", () => {
  it("matches case- and separator-insensitively", () => {
    expect(matchProject("drydock", PROJECTS)).toBe("p1");
    expect(matchProject("DryDock", PROJECTS)).toBe("p1");
    expect(matchProject("robotics-leadership", PROJECTS)).toBe("p2");
    expect(matchProject("firstpassrx", PROJECTS)).toBe("p3");
    expect(matchProject("ppahelper", PROJECTS)).toBe("p4");
  });

  it("matches on a unique prefix", () => {
    expect(matchProject("robotics", PROJECTS)).toBe("p2");
  });

  it("returns null for an AMBIGUOUS prefix rather than picking one", () => {
    // Wrongly assigning a capture is worse than leaving it unassigned:
    // unassigned is visible in the inbox and one tap from fixed, while a
    // wrong assignment looks correct and hides.
    const ambiguous = [
      { id: "a", name: "Ferc Docs" },
      { id: "b", name: "Ferc Orders" },
    ];
    expect(matchProject("ferc", ambiguous)).toBeNull();
  });

  it("returns null with no projects or an empty marker", () => {
    expect(matchProject("drydock", [])).toBeNull();
    expect(matchProject("", PROJECTS)).toBeNull();
  });
});

describe("slugify", () => {
  it("keeps letters and digits only, lowercased", () => {
    expect(slugify("Robotics Leadership")).toBe("roboticsleadership");
    expect(slugify("ppa-helper")).toBe("ppahelper");
    expect(slugify("FERC Show Cause Orders")).toBe("fercshowcauseorders");
  });
});

describe("titleSimilarity", () => {
  it("is 1 for identical wording", () => {
    expect(titleSimilarity("rate limiter for tunnel", "rate limiter for tunnel"))
      .toBe(1);
  });

  it("is high for a rephrasing", () => {
    expect(
      titleSimilarity(
        "add rate limiter to tunnel endpoints",
        "add rate limiter to the tunnel endpoints",
      ),
    ).toBeGreaterThanOrEqual(SIMILARITY_THRESHOLD);
  });

  it("is low for unrelated ideas", () => {
    expect(
      titleSimilarity("rate limiter for tunnel", "refresh the permit tracker"),
    ).toBeLessThan(SIMILARITY_THRESHOLD);
  });

  it("is 0 when either side has no substantive words", () => {
    expect(titleSimilarity("a to it", "rate limiter")).toBe(0);
  });
});

describe("findDuplicates", () => {
  const existing = [
    { id: "1", title: "Add a rate limiter to the tunnel endpoints" },
    { id: "2", title: "Refresh the permit tracker" },
  ];

  it("flags an exact title match", () => {
    const verdict = findDuplicates("refresh the permit tracker", existing);
    expect(verdict.exact).toBe(true);
  });

  it("reports near-matches without claiming they're the same", () => {
    // The contract the whole intake path rests on: a similar title is
    // REPORTED, never silently dropped. False-positive dedup is a
    // swallowed idea; an extra inbox row is one tap.
    const verdict = findDuplicates(
      "Add rate limiter to tunnel endpoints",
      existing,
    );
    expect(verdict.exact).toBe(false);
    expect(verdict.similar[0].id).toBe("1");
    expect(verdict.similar[0].score).toBeGreaterThanOrEqual(
      SIMILARITY_THRESHOLD,
    );
  });

  it("reports nothing for a genuinely new idea", () => {
    const verdict = findDuplicates("Buy a new coffee grinder", existing);
    expect(verdict.exact).toBe(false);
    expect(verdict.similar).toEqual([]);
  });

  it("sorts near-matches most-similar first", () => {
    const verdict = findDuplicates("Refresh the permit tracker", [
      ...existing.filter((e) => e.id !== "2"),
      { id: "3", title: "Refresh the permit tracker weekly" },
      { id: "4", title: "Refresh the permit tracker data on a schedule" },
    ]);
    expect(verdict.similar.length).toBeGreaterThan(1);
    expect(verdict.similar[0].score).toBeGreaterThanOrEqual(
      verdict.similar[1].score,
    );
  });
});
