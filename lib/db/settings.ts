import { getDb } from "./index";

/**
 * Tiny key-value settings store. Single-user instance — there's exactly
 * one row per concept (monthly_budget_usd, apple_notes_title, etc).
 *
 * Values are always TEXT in SQLite; callers cast as needed. Numbers use
 * `getNumberSetting` to centralize the parse + isFinite check so callers
 * don't all have to remember to handle bad data.
 */

export function getSetting(key: string): string | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT value FROM settings WHERE key = ?`)
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

export function deleteSetting(key: string): void {
  const db = getDb();
  db.prepare(`DELETE FROM settings WHERE key = ?`).run(key);
}

export function getNumberSetting(key: string): number | null {
  const raw = getSetting(key);
  if (raw === null) return null;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Read a boolean setting. Only the literal string `"true"` counts as true —
 * anything else (including legacy garbage from a previous value) is false so
 * we never silently flip an opt-in behavior on.
 */
export function getBooleanSetting(key: string, fallback = false): boolean {
  const raw = getSetting(key);
  if (raw === null) return fallback;
  return raw === "true";
}
