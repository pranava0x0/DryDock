import Database from "better-sqlite3";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/**
 * Resolve the database file path.
 *
 * Resolution order (so tests can override without touching the env):
 *   1. explicit `path` argument
 *   2. DRYDOCK_DB_PATH environment variable
 *   3. ~/.drydock/drydock.db (the production default)
 *
 * The DB lives outside the repo by default — that's how we make sure the file
 * is never accidentally committed.
 */
export function resolveDbPath(explicit?: string): string {
  if (explicit) return explicit;
  const envPath = process.env.DRYDOCK_DB_PATH;
  if (envPath && envPath.length > 0) return envPath;
  return join(homedir(), ".drydock", "drydock.db");
}

const SCHEMA_PATH = join(process.cwd(), "lib", "db", "schema.sql");

type DB = Database.Database;

let cachedDb: DB | null = null;
let cachedDbPath: string | null = null;

/**
 * Open (or return the cached) SQLite connection.
 *
 * `better-sqlite3` is synchronous — a process holds one connection for its
 * lifetime, and that single connection is safe to share across requests. The
 * cache key is the path so tests can swap to a fresh in-memory DB cleanly.
 */
export function getDb(path?: string): DB {
  const target = resolveDbPath(path);
  if (cachedDb && cachedDbPath === target) return cachedDb;

  // Ensure the parent directory exists before opening the file. `:memory:` and
  // empty paths are special-cased — they don't have a real parent directory.
  if (target !== ":memory:" && target.length > 0) {
    mkdirSync(dirname(target), { recursive: true });
  }

  const db = new Database(target);
  // WAL gives us concurrent reads while a single writer is in flight, which is
  // important once the SSE stream route is reading task state while the
  // dispatcher writes run output.
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  const schema = readFileSync(SCHEMA_PATH, "utf8");
  db.exec(schema);

  // CREATE TABLE IF NOT EXISTS is a no-op for tables that already exist,
  // so when a Phase 1 / Phase 2 DB is opened by Phase 3 code the new
  // columns (test_command, tokens_*, gate_*) won't appear. Bring the
  // schema forward with idempotent ALTER TABLE statements.
  migrate(db);

  cachedDb = db;
  cachedDbPath = target;
  return db;
}

interface TableInfoRow {
  name: string;
}

function migrate(db: DB): void {
  const columnNames = (table: string): Set<string> => {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as TableInfoRow[];
    return new Set(rows.map((r) => r.name));
  };

  const ensure = (table: string, column: string, ddl: string): void => {
    if (!columnNames(table).has(column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
  };

  ensure("projects", "test_command", "test_command TEXT");
  ensure("runs", "tokens_in", "tokens_in INTEGER");
  ensure("runs", "tokens_out", "tokens_out INTEGER");
  ensure("runs", "cost_usd", "cost_usd REAL");
  ensure("runs", "gate_status", "gate_status TEXT");
  ensure("runs", "gate_output", "gate_output TEXT");

  // settings + backlog_items: covered by the CREATE TABLE IF NOT EXISTS
  // statements in schema.sql for fresh DBs. For databases that existed
  // before these tables were added, the IF NOT EXISTS makes the create
  // safe to re-run, but a column-level migration is still a good belt
  // for future renames — keep this list current as the schema evolves.
}

/**
 * Reset the cached connection. Tests call this between cases so each test
 * sees a fresh DB; production never needs it.
 */
export function _resetDbForTests(): void {
  if (cachedDb) {
    try {
      cachedDb.close();
    } catch {
      // already closed — nothing to do
    }
  }
  cachedDb = null;
  cachedDbPath = null;
}
