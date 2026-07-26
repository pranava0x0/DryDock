import { promises as fs } from "node:fs";
import { join } from "node:path";
import { listProjects, type Project } from "../db/projects";
import {
  getBacklogItemByExternalId,
  updateBacklogItem,
} from "../db/backlog";
import { intakeCapture } from "../orchestrator/intake";

/**
 * Pull each project's **own** backlog file into DryDock's inbox.
 *
 * Every project in this portfolio already keeps a backlog in-repo —
 * `backlog.md`, `drydock-backlog.md`, `BACKLOG.md`, `TODO.md`. Those are
 * where ideas actually get written down, in the editor, while the work is
 * fresh. DryDock's global backlog couldn't see any of them, so
 * cross-project prioritisation was working from a strict subset of what
 * the user had actually written.
 *
 * ── Read-only, and one-directional on purpose ───────────────────────────
 * This connector **never writes to a project's file**. Those files are
 * hand-maintained prose with tables, section headers, and per-project
 * conventions that vary; a sync that rewrote them would eventually mangle
 * one, and the blast radius is someone else's repo. Items flow
 * file → inbox, and that's it. Burning one down still happens in DryDock.
 *
 * ── Everything lands in the inbox ───────────────────────────────────────
 * A project file can hold hundreds of lines including long-since-done
 * items. Dumping those straight into the trusted backlog would drown it.
 * They arrive untriaged, so a sweep is a deliberate act.
 */

/** Filenames checked per project, in priority order. */
export const BACKLOG_FILENAMES = [
  "backlog.md",
  "drydock-backlog.md",
  "BACKLOG.md",
  "TODO.md",
  "todo.md",
] as const;

/** Hard ceiling per project per run, so one huge file can't flood the inbox. */
export const MAX_ITEMS_PER_PROJECT = 40;

export interface ProjectBacklogItem {
  title: string;
  /** True when the source line was already checked/struck through. */
  done: boolean;
  /** Section heading the line sat under, when there was one. */
  section: string | null;
  /**
   * 0-based position among the file's parsed items. This is the row's
   * stable identity — a title can be reworded, a position usually can't.
   */
  ordinal: number;
}

export interface ProjectBacklogScan {
  projectId: string;
  projectName: string;
  file: string | null;
  /** Open items, capped. These create or refresh inbox rows. */
  items: ProjectBacklogItem[];
  /**
   * Items already checked off in the source file. Never create a row —
   * they exist so a row imported while the line was open can be closed
   * when the line is later ticked.
   */
  completed: ProjectBacklogItem[];
  /** Items beyond MAX_ITEMS_PER_PROJECT that were NOT imported. */
  skipped: number;
  reason: string | null;
}

/**
 * Parse a markdown backlog into candidate items.
 *
 * Recognizes the two shapes these files actually use:
 *   - task list items — `- [ ] thing` / `* [x] done thing`
 *   - plain bullets   — `- thing`
 *   - table rows      — `| DD-BL-12 | Feature… | P2 | … |`
 *
 * Everything else (prose, headings, code fences, HTML comments) is
 * skipped. Fenced code blocks are tracked explicitly — a `- item` inside
 * a shell example is not a backlog item, and importing one would be a
 * confusing piece of noise with no obvious origin.
 */
export function parseBacklogMarkdown(content: string): ProjectBacklogItem[] {
  const items: ProjectBacklogItem[] = [];
  let inFence = false;
  let section: string | null = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (line.startsWith("```") || line.startsWith("~~~")) {
      inFence = !inFence;
      continue;
    }
    if (inFence || line.length === 0) continue;

    if (line.startsWith("#")) {
      section = line.replace(/^#+\s*/, "").trim() || null;
      continue;
    }

    const table = parseTableRow(line);
    if (table) {
      items.push({ ...table, section, ordinal: items.length });
      continue;
    }

    const bullet = line.match(/^[-*+]\s+(.*)$/);
    if (!bullet) continue;
    let text = bullet[1].trim();

    let done = false;
    const checkbox = text.match(/^\[([ xX])\]\s*(.*)$/);
    if (checkbox) {
      done = checkbox[1].toLowerCase() === "x";
      text = checkbox[2].trim();
    }
    // `~~struck through~~` is the other way these files mark completion.
    const struck = text.match(/^~~(.*)~~$/);
    if (struck) {
      done = true;
      text = struck[1].trim();
    }

    text = stripMarkdown(text);
    if (text.length === 0) continue;
    items.push({ title: text, done, section, ordinal: items.length });
  }

  return items;
}

/**
 * A DD-BL-style table row. These files use a `| ID | Feature | … |`
 * layout where the *second* cell is the human-readable item and a later
 * cell often carries a status. Rows whose status reads as shipped are
 * marked done rather than skipped, so a re-import doesn't resurrect them.
 */
function parseTableRow(line: string): { title: string; done: boolean } | null {
  if (!line.startsWith("|") || !line.endsWith("|")) return null;
  const cells = line
    .slice(1, -1)
    .split("|")
    .map((c) => c.trim());
  if (cells.length < 3) return null;
  // Separator row (`|---|---|`) and header row.
  if (cells.every((c) => /^:?-{2,}:?$/.test(c))) return null;
  if (/^(id|feature|phase|description)$/i.test(cells[0])) return null;

  const title = stripMarkdown(cells[1]);
  if (title.length === 0) return null;
  const statusCell = cells[cells.length - 1].toLowerCase();
  const done = /shipped|done|complete|resolved/.test(statusCell);
  return { title, done };
}

/** Strip links, code ticks, and bold/italic so titles read as plain text. */
function stripMarkdown(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]*)\*\*/g, "$1")
    .replace(/(^|\s)[*_]([^*_]+)[*_](\s|$)/g, "$1$2$3")
    .replace(/<!--.*?-->/g, "")
    .trim();
}

/** Locate and read a project's backlog file, if it has one. */
export async function scanProjectBacklog(
  project: Project,
): Promise<ProjectBacklogScan> {
  const base: ProjectBacklogScan = {
    projectId: project.id,
    projectName: project.name,
    file: null,
    items: [],
    completed: [],
    skipped: 0,
    reason: null,
  };

  // Distinguish "this project has no backlog file" from "this project's
  // directory isn't there any more". They look identical from a failed
  // read, but they need completely different fixes — and the second is
  // the common one: a project imported under an older
  // DRYDOCK_PROJECTS_ROOT keeps a path that no longer resolves, and
  // reporting that as "no backlog file" sends the user looking in the
  // wrong place for a file that exists.
  try {
    const stat = await fs.stat(project.path);
    if (!stat.isDirectory()) {
      return { ...base, reason: `project path is not a directory: ${project.path}` };
    }
  } catch {
    return {
      ...base,
      reason: `project path no longer exists: ${project.path} — re-import it from /discover`,
    };
  }

  for (const filename of BACKLOG_FILENAMES) {
    const path = join(project.path, filename);
    let content: string;
    try {
      content = await fs.readFile(path, "utf8");
    } catch {
      continue;
    }
    const parsed = parseBacklogMarkdown(content);
    const open = parsed.filter((i) => !i.done);
    return {
      ...base,
      file: filename,
      items: open.slice(0, MAX_ITEMS_PER_PROJECT),
      // Completed entries are carried separately, NOT dropped. Filtering
      // them out entirely meant that ticking a line in the source file
      // left its already-imported DryDock row actionable forever — the
      // import loop simply never saw it again (Codex, PR #8). They're
      // used to close existing rows, never to create new ones.
      completed: parsed.filter((i) => i.done),
      skipped: Math.max(0, open.length - MAX_ITEMS_PER_PROJECT),
      reason: null,
    };
  }

  return { ...base, reason: "no backlog file found in the project root" };
}

export interface ProjectBacklogImport {
  projectId: string;
  projectName: string;
  file: string | null;
  created: number;
  updated: number;
  duplicates: number;
  /** Rows closed because their source line is now ticked. */
  completed: number;
  skipped: number;
  reason: string | null;
}

/**
 * Import every project's backlog file into the inbox.
 *
 * Idempotent by construction: each line carries an `external_id` of
 * `projfile:<projectId>:<slug>`, so re-running refreshes rather than
 * duplicates, and an item that already exists in DryDock under the same
 * title is reported as a duplicate rather than added again.
 */
export async function importProjectBacklogs(): Promise<ProjectBacklogImport[]> {
  const results: ProjectBacklogImport[] = [];

  for (const project of listProjects()) {
    const scan = await scanProjectBacklog(project);
    const outcome: ProjectBacklogImport = {
      projectId: project.id,
      projectName: project.name,
      file: scan.file,
      created: 0,
      updated: 0,
      duplicates: 0,
      completed: 0,
      skipped: scan.skipped,
      reason: scan.reason,
    };

    for (const item of scan.items) {
      const result = intakeCapture({
        text: item.title,
        source: "project-file",
        // Identity is (project, file, ordinal) — NOT the title slug.
        // A slug changes the moment the line is edited, so the next
        // import couldn't find the old row: it created a second one and
        // left the stale title behind, contradicting the connector's own
        // update semantics (Codex, PR #8). Position is stable across a
        // rewording, which is the common edit; a reorder re-links rows to
        // each other's lines, which is why the description carries the
        // source file and section so a mismatch is visible.
        externalId: `projfile:${project.id}:${scan.file}:${item.ordinal}`,
        // The project is known from the file's location — far more
        // reliable than a `#marker`, so it overrides the parsed one.
        projectId: project.id,
        description: `From ${project.name}/${scan.file}${
          item.section ? ` · ${item.section}` : ""
        }`,
      });
      if (result.outcome === "created") outcome.created += 1;
      else if (result.outcome === "updated") outcome.updated += 1;
      else outcome.duplicates += 1;
    }

    // Reconcile completions: a line that is now ticked in the source file
    // closes the row it created, rather than leaving it actionable
    // forever. Only ever touches a row this connector already made —
    // `getBacklogItemByExternalId` keyed on the projfile namespace — so
    // it can't reach anything the user entered by hand.
    for (const item of scan.completed) {
      const existing = getBacklogItemByExternalId(
        `projfile:${project.id}:${scan.file}:${item.ordinal}`,
      );
      if (!existing || existing.status === "done") continue;
      updateBacklogItem(existing.id, { status: "done" });
      outcome.completed += 1;
    }

    results.push(outcome);
  }

  return results;
}
