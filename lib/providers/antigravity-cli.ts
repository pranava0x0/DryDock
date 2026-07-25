import Database from "better-sqlite3";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Second Antigravity store: the `agy` CLI's SQLite conversation files
 * (DD-BL-38).
 *
 * The shipped reader ([gemini-usage.ts](gemini-usage.ts)) only sees the
 * *IDE's* step logs under `~/.gemini/antigravity/brain/`. The CLI keeps
 * its conversations somewhere else — `~/.gemini/antigravity-cli/*.db` —
 * so CLI-only usage reads as zero activity.
 *
 * ── Honesty, because this schema is NOT verified ────────────────────────
 * That directory does not exist on the machine this was written against,
 * so there was no real database to read. Rather than hardcode a guessed
 * table name and silently return zeros (or worse, wrong counts) when the
 * guess misses, this probe is **schema-discovering**: it introspects
 * `sqlite_master`, looks for a table carrying a plausible timestamp
 * column, and reports back exactly which table and column it used. If it
 * finds nothing it says `unavailable` with a reason — it never
 * synthesizes a number.
 *
 * Everything here is **turns/activity, not tokens**. Token counts are
 * confirmed absent from every local Antigravity format; a caller that
 * renders these as tokens is lying to the user.
 *
 * Read-only throughout: the DB is opened `readonly` + `fileMustExist`, we
 * only ever run COUNT queries, and no message content is read.
 */

export type AntigravityCliHealth = "ok" | "no-data" | "unavailable";

export interface AntigravityCliReport {
  health: AntigravityCliHealth;
  /** Human-readable explanation. Always set for non-"ok" health. */
  reason: string | null;
  /** Conversation databases found under the CLI directory. */
  databases: number;
  /** Activity events (rows) at or after the cutoff, summed across DBs. */
  events: number;
  /** Distinct conversation databases with at least one in-window row. */
  conversations: number;
  /**
   * Where the counts came from, per database — the discovered table and
   * timestamp column. Surfaced so a human can sanity-check the guess
   * instead of trusting an opaque number.
   */
  sources: Array<{ database: string; table: string; column: string }>;
}

/** Column names that plausibly hold an event timestamp, best first. */
const TIMESTAMP_COLUMNS = [
  "created_at",
  "createdAt",
  "timestamp",
  "created",
  "updated_at",
  "updatedAt",
  "time",
];

interface MasterRow {
  name: string;
}
interface ColumnRow {
  name: string;
  type: string;
}

function emptyReport(
  health: AntigravityCliHealth,
  reason: string,
): AntigravityCliReport {
  return {
    health,
    reason,
    databases: 0,
    events: 0,
    conversations: 0,
    sources: [],
  };
}

/**
 * Count Antigravity CLI activity at or after `cutoff`.
 *
 * Defaults to `~/.gemini/antigravity-cli`; tests inject a fixture dir.
 * Never throws for the ordinary "not installed" case — that is a
 * `unavailable` health state the UI renders as a deep-link card, exactly
 * like the other providers' empty states.
 */
export async function readAntigravityCliActivity(
  rootDir: string = join(homedir(), ".gemini", "antigravity-cli"),
  cutoff: Date = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
): Promise<AntigravityCliReport> {
  let entries: string[];
  try {
    entries = await fs.readdir(rootDir);
  } catch {
    return emptyReport(
      "unavailable",
      "no ~/.gemini/antigravity-cli directory — the agy CLI has not run here",
    );
  }

  const dbFiles = entries.filter(
    (f) => f.endsWith(".db") || f.endsWith(".sqlite") || f.endsWith(".sqlite3"),
  );
  if (dbFiles.length === 0) {
    return emptyReport(
      "no-data",
      "antigravity-cli directory exists but holds no SQLite conversation files",
    );
  }

  const report: AntigravityCliReport = {
    health: "ok",
    reason: null,
    databases: dbFiles.length,
    events: 0,
    conversations: 0,
    sources: [],
  };
  let readable = 0;

  for (const file of dbFiles) {
    const counted = countInDatabase(join(rootDir, file), cutoff);
    if (counted === null) continue;
    readable += 1;
    report.events += counted.events;
    if (counted.events > 0) report.conversations += 1;
    report.sources.push({
      database: file,
      table: counted.table,
      column: counted.column,
    });
  }

  if (readable === 0) {
    return {
      ...emptyReport(
        "unavailable",
        `found ${dbFiles.length} SQLite file(s) but none exposed a table with a recognizable timestamp column — the agy schema has changed or was never what we guessed`,
      ),
      databases: dbFiles.length,
    };
  }
  return report;
}

/**
 * Open one database read-only, discover a timestamp-bearing table, and
 * count rows at or after the cutoff. Returns null when the file can't be
 * opened or nothing matched — the caller aggregates those into an honest
 * "unavailable", never a zero.
 */
function countInDatabase(
  path: string,
  cutoff: Date,
): { events: number; table: string; column: string } | null {
  let db: Database.Database;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
  try {
    // better-sqlite3 opens lazily — a file that isn't a database at all
    // constructs fine and only throws ("file is not a database") on the
    // first query, so the catch has to cover the reads, not just the
    // open. A stray non-SQLite `.db` in the directory must not take the
    // whole provider down.
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
      )
      .all() as MasterRow[];

    for (const { name: table } of tables) {
      // Identifiers can't be bound as parameters, and PRAGMA won't accept
      // one either — so validate the name against SQLite's own catalogue
      // shape before interpolating. Anything with a quote, space, or
      // punctuation is rejected rather than escaped.
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) continue;
      const columns = db
        .prepare(`PRAGMA table_info("${table}")`)
        .all() as ColumnRow[];
      const names = new Set(columns.map((c) => c.name));
      const column = TIMESTAMP_COLUMNS.find((c) => names.has(c));
      if (!column) continue;

      const events = countRows(db, table, column, cutoff);
      if (events === null) continue;
      return { events, table, column };
    }
    return null;
  } catch {
    return null;
  } finally {
    try {
      db.close();
    } catch {
      // Already closed / never opened cleanly — nothing to do.
    }
  }
}

/**
 * Above this, an epoch number has to be milliseconds: 1e11 seconds is the
 * year 5138, and 1e11 milliseconds is 1973 — so no plausible timestamp is
 * ambiguous across the boundary.
 */
const MILLIS_THRESHOLD = 100_000_000_000;

/**
 * COUNT rows at or after `cutoff`, tolerating the timestamp encodings a
 * JS/TS CLI plausibly writes: epoch seconds, epoch milliseconds, and
 * ISO-8601 strings. Each row is classified by magnitude *before* being
 * compared — a naive `col >= seconds OR col >= millis` would match every
 * millisecond row regardless of the cutoff (millis always dwarf a seconds
 * threshold) and report a week's activity as if it happened today.
 */
function countRows(
  db: Database.Database,
  table: string,
  column: string,
  cutoff: Date,
): number | null {
  const epochSeconds = Math.floor(cutoff.getTime() / 1000);
  const epochMillis = cutoff.getTime();
  const iso = cutoff.toISOString();
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM "${table}"
          WHERE (typeof("${column}") IN ('integer','real')
                 AND CASE WHEN "${column}" > ${MILLIS_THRESHOLD}
                          THEN "${column}" >= ?
                          ELSE "${column}" >= ?
                     END)
             OR (typeof("${column}") = 'text' AND "${column}" >= ?)`,
      )
      .get(epochMillis, epochSeconds, iso) as { n: number } | undefined;
    return row?.n ?? null;
  } catch {
    return null;
  }
}
