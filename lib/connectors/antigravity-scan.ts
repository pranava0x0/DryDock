import { promises as fs, createReadStream } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { mayContainRecentTurns } from "../providers/usage-mtime";
import { readAntigravityCliActivity } from "../providers/antigravity-cli";
import { localDayKey, localHour } from "../util/day";
import {
  emptyUsageRow,
  type UsageDailyRow,
  type UsageHourlyRow,
} from "../db/usage";

/**
 * Per-day scan of Google Antigravity's IDE step logs.
 *
 * ── Activity, never tokens ──────────────────────────────────────────────
 * Antigravity persists no token counts anywhere on disk — verified across
 * every local format — and Google publishes no consumer usage API. So
 * these rows carry `events` and `turns` with all token columns at zero,
 * and every surface that renders them must say "activity", not "tokens".
 * A Google row summed into a token total would read as "you used Google
 * for nothing this month", which is worse than showing no number at all.
 *
 * There's no model and no cwd in the step log either, so `model` and
 * `project_key` stay `''` → "unknown". Guessing either would be inventing
 * data to fill a column.
 */

export interface AntigravityScanResult {
  daily: UsageDailyRow[];
  hourly: UsageHourlyRow[];
  conversationsScanned: number;
  latestActivityAt: string | null;
  rootMissing: boolean;
}

interface Accumulator {
  row: UsageDailyRow;
  conversations: Set<string>;
}

export async function scanAntigravityActivity(
  rootDir: string = join(homedir(), ".gemini", "antigravity", "brain"),
  since: Date = new Date(0),
  // Absolute, not derived from `rootDir` — the CLI store is not a sibling
  // of the IDE's brain dir, and walking up from a fixture path would read
  // whatever sits next to the OS temp directory.
  cliDir: string = join(homedir(), ".gemini", "antigravity-cli"),
): Promise<AntigravityScanResult> {
  // The `agy` CLI keeps its own SQLite store, separate from the IDE logs.
  // It was previously surfaced only on the Settings card, so a CLI-only
  // user's activity never reached the ledger and the Usage tab reported
  // Google as unavailable (Codex, PR #8).
  const cli = await readAntigravityCliActivity(cliDir, since);

  let convDirs: string[];
  try {
    convDirs = await fs.readdir(rootDir);
  } catch {
    // Only genuinely missing when NEITHER store is present. A CLI-only
    // install has real activity to report.
    if (cli.health !== "ok" || cli.events === 0) {
      return {
        daily: [],
        hourly: [],
        conversationsScanned: 0,
        latestActivityAt: null,
        rootMissing: true,
      };
    }
    convDirs = [];
  }

  const daily = new Map<string, Accumulator>();
  const hourly = new Map<string, UsageHourlyRow>();
  let conversationsScanned = 0;
  let latestActivityAt: string | null = null;

  for (const conv of convDirs) {
    const logsDir = join(rootDir, conv, ".system_generated", "logs");
    let logFiles: string[];
    try {
      logFiles = await fs.readdir(logsDir);
    } catch {
      // Not a conversation dir (e.g. `tempmediaStorage`) or no logs yet.
      continue;
    }

    let scanned = false;
    for (const file of logFiles) {
      // Older conversations write overview.txt, newer ones
      // transcript.jsonl; both share the same line shape.
      if (!file.endsWith(".jsonl") && !file.endsWith(".txt")) continue;
      const logPath = join(logsDir, file);
      if (!(await mayContainRecentTurns(logPath, since))) continue;
      scanned = true;
      await scanLog(logPath, conv, since, daily, hourly, (ts) => {
        if (latestActivityAt === null || ts > latestActivityAt) {
          latestActivityAt = ts;
        }
      });
    }
    if (scanned) conversationsScanned += 1;
  }

  for (const acc of daily.values()) acc.row.sessions = acc.conversations.size;

  // The CLI probe reports a single in-window total rather than per-day
  // rows — its schema is unverified and inventing a daily distribution
  // from one number would be fabrication. Attribute it to the scan's
  // start day and label it plainly.
  if (cli.health === "ok" && cli.events > 0) {
    const day = localDayKey(since.getTime() > 0 ? since : new Date());
    const existing = daily.get(day);
    if (existing) {
      existing.row.events += cli.events;
    } else {
      const row = emptyUsageRow(day, "google", "cli");
      row.events = cli.events;
      row.sessions = cli.conversations;
      daily.set(day, { row, conversations: new Set() });
    }
  }

  return {
    daily: [...daily.values()].map((a) => a.row),
    hourly: [...hourly.values()],
    conversationsScanned,
    latestActivityAt,
    rootMissing: false,
  };
}

async function scanLog(
  filePath: string,
  conversationId: string,
  since: Date,
  daily: Map<string, Accumulator>,
  hourly: Map<string, UsageHourlyRow>,
  onLatest: (ts: string) => void,
): Promise<void> {
  const stream = createReadStream(filePath, { encoding: "utf-8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (line.length === 0) continue;
      if (!line.includes('"created_at"')) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isPlainObject(parsed)) continue;
      const ts =
        typeof parsed.created_at === "string" ? parsed.created_at : null;
      if (!ts) continue;
      const at = new Date(ts);
      if (Number.isNaN(at.getTime())) continue;

      onLatest(ts);
      if (at < since) continue;

      const day = localDayKey(at);
      let acc = daily.get(day);
      if (!acc) {
        acc = {
          row: emptyUsageRow(day, "google", "cli"),
          conversations: new Set(),
        };
        daily.set(day, acc);
      }
      acc.row.events += 1;
      // `turns` counts model responses specifically, so the Usage tab can
      // say "N model turns" rather than the much larger raw step count
      // (which includes every file view and tool call).
      const isModelTurn = parsed.type === "PLANNER_RESPONSE";
      if (isModelTurn) acc.row.turns += 1;
      acc.conversations.add(conversationId);

      const hour = localHour(at);
      const hourKey = `${day} ${hour}`;
      let hourRow = hourly.get(hourKey);
      if (!hourRow) {
        hourRow = { day, hour, provider: "google", turns: 0, events: 0 };
        hourly.set(hourKey, hourRow);
      }
      hourRow.events += 1;
      if (isModelTurn) hourRow.turns += 1;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
