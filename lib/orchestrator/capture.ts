/**
 * Capture parsing (EP-12 Spec A) — pure, no DB.
 *
 * ── Capture is permissive; clarify comes later ──────────────────────────
 * The whole point of a five-second capture channel is that it works at a
 * stoplight or in bed. So parsing recognizes a small set of **optional
 * trailing markers** and never rejects anything: a capture with no
 * markers, garbled markers, or markers in the middle of a sentence still
 * becomes a row with the full text as its title. Nothing is ever dropped
 * for failing to parse, and `raw` always carries the original.
 *
 * Markers, trailing only:
 *   `#project-slug`   fuzzy-matched against known project names
 *   `p1`–`p4`         priority (p1 = most urgent → highest priority value)
 *
 * Trailing-only is deliberate. "fix the #2 bug in p1 mode" is a title,
 * not a project called "2" at priority 1 — and a parser that reached into
 * the middle of a sentence would silently mangle exactly the kind of
 * hurried text this feature exists to accept.
 */

export interface ParsedCapture {
  /** Title after stripping recognized trailing markers. Never empty. */
  title: string;
  /** Matched project id, or null when no marker matched a real project. */
  projectId: string | null;
  /** The `#slug` as typed, kept even when it matched nothing. */
  projectMarker: string | null;
  /** 0 when unspecified. p1 → 3, p2 → 2, p3 → 1, p4 → 0. */
  priority: number;
  /** The input, verbatim. Stored so parsing can never lose information. */
  raw: string;
}

export interface CaptureProject {
  id: string;
  name: string;
}

/**
 * p1 is the *most* urgent, but `backlog_items.priority` sorts DESC — so
 * the mapping inverts. Getting this backwards would file every urgent
 * capture at the bottom of the list, which is the one failure mode a
 * capture channel can't survive.
 */
const PRIORITY_BY_MARKER: Record<string, number> = {
  p1: 3,
  p2: 2,
  p3: 1,
  p4: 0,
};

const PROJECT_MARKER = /^#([\p{L}\p{N}][\p{L}\p{N}._-]*)$/u;
const PRIORITY_MARKER = /^p[1-4]$/i;

export function parseCapture(
  text: string,
  projects: CaptureProject[] = [],
): ParsedCapture {
  const raw = typeof text === "string" ? text : "";
  const words = raw.trim().split(/\s+/).filter((w) => w.length > 0);

  let priority = 0;
  let projectMarker: string | null = null;

  // Walk backwards, consuming recognized markers. Stop at the first word
  // that isn't one — markers are a trailing suffix, not a scan.
  let end = words.length;
  while (end > 0) {
    const word = words[end - 1];
    if (PRIORITY_MARKER.test(word) && priority === 0) {
      priority = PRIORITY_BY_MARKER[word.toLowerCase()];
      end -= 1;
      continue;
    }
    const projectMatch = word.match(PROJECT_MARKER);
    if (projectMatch && projectMarker === null) {
      projectMarker = projectMatch[1];
      end -= 1;
      continue;
    }
    break;
  }

  let title = words.slice(0, end).join(" ");
  if (title.length === 0) {
    // The capture was *only* markers ("p1", "#drydock"). Rather than
    // create a titleless row or drop it, keep the original text as the
    // title — the user clearly meant something and the inbox is where
    // ambiguity gets resolved.
    title = raw.trim();
    projectMarker = null;
    priority = 0;
  }

  return {
    title,
    projectId: projectMarker ? matchProject(projectMarker, projects) : null,
    projectMarker,
    priority,
    raw,
  };
}

/**
 * Fuzzy-match a `#marker` to a project.
 *
 * Order: exact slug, then case-insensitive name, then a slugified
 * comparison ("firstpassrx" matches "FirstPassRx", "robotics-leadership"
 * matches "Robotics Leadership"), then a unique prefix.
 *
 * An **ambiguous prefix matches nothing.** Filing a capture under the
 * wrong project is worse than leaving it unassigned: unassigned is
 * visible in the inbox and fixed with one tap, while a wrong assignment
 * looks correct and hides.
 */
export function matchProject(
  marker: string,
  projects: CaptureProject[],
): string | null {
  if (projects.length === 0) return null;
  const needle = slugify(marker);
  if (needle.length === 0) return null;

  const exact = projects.filter((p) => slugify(p.name) === needle);
  if (exact.length === 1) return exact[0].id;
  if (exact.length > 1) return null;

  const prefix = projects.filter((p) => slugify(p.name).startsWith(needle));
  return prefix.length === 1 ? prefix[0].id : null;
}

/** Lowercase, strip everything that isn't a letter or digit. */
export function slugify(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

// ── Dedup (EP-14 Spec B, used by every inbound feeder) ──────────────────

/**
 * Word-shingle Jaccard similarity over two titles, 0–1.
 *
 * Dependency-free on purpose: embeddings would add a model dependency
 * for marginal gain at a few hundred titles (see the plan's
 * "decided against" table).
 */
export function titleSimilarity(a: string, b: string): number {
  const setA = shingles(a);
  const setB = shingles(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function shingles(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 2),
  );
}

/** Above this, two titles are "possibly the same idea". */
export const SIMILARITY_THRESHOLD = 0.6;

export interface DedupVerdict {
  /** An exact (trimmed, case-folded) title match. Safe to treat as same. */
  exact: boolean;
  /** Titles above the similarity threshold, most similar first. */
  similar: Array<{ id: string; title: string; score: number }>;
}

/**
 * Compare a candidate title against existing ones.
 *
 * **This never says "drop it".** A near-match is reported so the caller
 * can insert the row *with a note* pointing at what it resembles —
 * silently discarding a real idea because it scored 0.61 against
 * something else is exactly the silent failure the house rules ban, and
 * an unwanted duplicate costs one tap in the inbox while a swallowed
 * idea is gone.
 */
export function findDuplicates(
  title: string,
  existing: Array<{ id: string; title: string }>,
): DedupVerdict {
  const normalized = title.trim().toLowerCase();
  const similar: Array<{ id: string; title: string; score: number }> = [];
  let exact = false;

  for (const row of existing) {
    if (row.title.trim().toLowerCase() === normalized) {
      exact = true;
      continue;
    }
    const score = titleSimilarity(title, row.title);
    if (score >= SIMILARITY_THRESHOLD) {
      similar.push({ id: row.id, title: row.title, score });
    }
  }
  similar.sort((a, b) => b.score - a.score);
  return { exact, similar };
}
