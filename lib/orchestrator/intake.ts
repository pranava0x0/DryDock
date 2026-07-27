import {
  createBacklogItem,
  getBacklogItemByExternalId,
  listBacklog,
  updateBacklogItem,
  type BacklogItem,
  type BacklogSource,
  type BacklogStatus,
} from "../db/backlog";
import { listProjects } from "../db/projects";
import { findDuplicates, parseCapture, type ParsedCapture } from "./capture";

/**
 * The single door into the inbox (EP-12 / EP-14).
 *
 * Every inbound feeder — the capture endpoint, Siri, iMessage, the
 * project-backlog connector, the nightly idea generator via MCP — comes
 * through here, so the parsing, dedup, and never-drop guarantees are
 * written once rather than re-derived per channel.
 *
 * ── Never drop a capture ────────────────────────────────────────────────
 * The two ways an intake path can silently lose an idea are (1) rejecting
 * input it can't parse and (2) deduping too eagerly. Both are prevented
 * here: unparseable text still becomes a row with the raw string as its
 * title, and a *similar* title is inserted anyway with a note pointing at
 * what it resembles. Only an **exact** title match (or a repeat of the
 * same `external_id`) is treated as the same item — everything else is
 * the user's call to make in the inbox, where it costs one tap.
 */

export interface IntakeInput {
  text: string;
  source: BacklogSource;
  /** Stable per-feeder key so a retry doesn't create a second row. */
  externalId?: string | null;
  description?: string | null;
  /** Overrides the parsed project (used by per-project feeders). */
  projectId?: string | null;
  status?: BacklogStatus;
}

export type IntakeOutcome =
  /** A new inbox row was created. */
  | "created"
  /** The same external_id already exists; its content was refreshed. */
  | "updated"
  /** An exact title match already exists; nothing was written. */
  | "duplicate";

export interface IntakeResult {
  outcome: IntakeOutcome;
  item: BacklogItem | null;
  parsed: ParsedCapture;
  /** Titles this one resembles. Reported, never acted on automatically. */
  similar: Array<{ id: string; title: string; score: number }>;
}

export function intakeCapture(input: IntakeInput): IntakeResult {
  const projects = listProjects().map((p) => ({ id: p.id, name: p.name }));
  const parsed = parseCapture(input.text, projects);

  // Idempotency first: a Shortcut retried over a flaky tunnel, or a
  // connector re-reading the same file line, must not mint a second row.
  if (input.externalId) {
    const existing = getBacklogItemByExternalId(input.externalId);
    if (existing) {
      const changed =
        existing.title !== parsed.title ||
        (input.description ?? null) !== existing.description;
      if (changed) {
        // Refresh in place rather than creating a new row — this is how
        // an edited backlog.md line or a re-generated idea spec updates
        // without duplicating.
        const updated = updateBacklogItem(existing.id, {
          title: parsed.title,
          ...(input.description !== undefined
            ? { description: input.description }
            : {}),
        });
        return { outcome: "updated", item: updated, parsed, similar: [] };
      }
      return { outcome: "duplicate", item: existing, parsed, similar: [] };
    }
  }

  // Compare against everything that isn't already dismissed. Including
  // triaged rows matters: re-capturing an idea you already accepted
  // should surface as "you already have this", not silently double it.
  const candidates = listBacklog()
    .filter((i) => i.status !== "dropped")
    .map((i) => ({ id: i.id, title: i.title }));
  const verdict = findDuplicates(parsed.title, candidates);

  if (verdict.exact) {
    const match = candidates.find(
      (c) => c.title.trim().toLowerCase() === parsed.title.trim().toLowerCase(),
    );
    const item = match
      ? (listBacklog().find((i) => i.id === match.id) ?? null)
      : null;
    return { outcome: "duplicate", item, parsed, similar: verdict.similar };
  }

  // A near-match is flagged in the description, not acted on. False-
  // positive dedup is the silent failure; an extra inbox row is one tap.
  const similarNote =
    verdict.similar.length > 0
      ? `Possibly similar to: ${verdict.similar
          .slice(0, 3)
          .map((s) => `"${s.title}"`)
          .join(", ")}`
      : null;
  const description =
    [input.description ?? null, similarNote].filter(Boolean).join("\n\n") ||
    null;

  const item = createBacklogItem({
    title: parsed.title,
    description,
    project_id: input.projectId ?? parsed.projectId,
    priority: parsed.priority,
    source: input.source,
    external_id: input.externalId ?? null,
    // Preserved verbatim so a parsing mistake is always recoverable.
    raw_capture: parsed.raw,
    status: input.status ?? "idea",
  });

  return { outcome: "created", item, parsed, similar: verdict.similar };
}
