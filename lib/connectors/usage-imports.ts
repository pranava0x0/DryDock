import {
  emptyUsageRow,
  upsertUsageDaily,
  type UsageDailyRow,
  type UsageProvider,
} from "../db/usage";
import { localDayKey } from "../util/day";

/**
 * Official export importers (EP-15 Spec A).
 *
 * Local CLI logs cover the terminal and the IDE. **Web-chat usage** —
 * claude.ai, chatgpt.com, gemini.google.com — has no API and, per the
 * providers' consumer terms, may not be scraped. What it does have is a
 * user-initiated data export, which is zero-ToS-risk, entirely
 * reliable, and slow. So: the user exports, drops the file here, and the
 * ledger fills in `surface='web'` rows beside the CLI ones.
 *
 * ── Schema drift is expected, not exceptional ───────────────────────────
 * These export formats change without notice and without versioning. So
 * every parser here: ignores unknown fields, skips a record it can't
 * read rather than failing the import, and **reports the skip count**. A
 * silent partial import is the failure mode to avoid — it looks like a
 * quiet month rather than a broken parser.
 *
 * Idempotent: rows land on the same `(day, provider, 'web', model, '')`
 * primary key, so re-importing an overlapping export overwrites rather
 * than doubling.
 */

export interface ImportResult {
  provider: UsageProvider;
  /** Ledger rows written. */
  rows: number;
  /** Messages successfully attributed to a day. */
  messages: number;
  /** Records skipped because they couldn't be read. */
  skipped: number;
  /** Earliest and latest day seen — rendered as import provenance. */
  fromDay: string | null;
  toDay: string | null;
  reason: string | null;
}

function empty(provider: UsageProvider, reason: string): ImportResult {
  return {
    provider,
    rows: 0,
    messages: 0,
    skipped: 0,
    fromDay: null,
    toDay: null,
    reason,
  };
}

/**
 * Timestamps in these exports are seconds, milliseconds, or ISO strings
 * depending on the provider and the year. Magnitude disambiguates the
 * numeric cases: 1e11 seconds is the year 5138.
 */
export function toDate(value: unknown): Date | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const ms = value > 100_000_000_000 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === "string" && value.length > 0) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

interface Bucket {
  row: UsageDailyRow;
}

function bucketKey(day: string, model: string): string {
  return `${day}|${model}`;
}

/**
 * ChatGPT's `conversations.json`: an array of conversations, each with a
 * `mapping` of message nodes. Per-message `metadata.model_slug` gives the
 * model, so the web surface gets a real model mix rather than one bar.
 *
 * Assistant messages only — counting the user's own turns would double
 * every exchange, and the question being answered is "how much model time
 * did I use".
 */
export function parseChatGptExport(input: unknown): ImportResult {
  const result = empty("codex", null as unknown as string);
  result.reason = null;
  if (!Array.isArray(input)) {
    return empty("codex", "expected conversations.json to be an array");
  }

  const buckets = new Map<string, Bucket>();
  for (const conversation of input) {
    if (!isObject(conversation)) {
      result.skipped += 1;
      continue;
    }
    const mapping = isObject(conversation.mapping) ? conversation.mapping : null;
    if (!mapping) {
      result.skipped += 1;
      continue;
    }
    for (const node of Object.values(mapping)) {
      if (!isObject(node)) continue;
      const message = isObject(node.message) ? node.message : null;
      if (!message) continue;
      const author = isObject(message.author) ? message.author : null;
      if (author?.role !== "assistant") continue;

      const at = toDate(message.create_time);
      if (!at) {
        result.skipped += 1;
        continue;
      }
      const metadata = isObject(message.metadata) ? message.metadata : null;
      const model =
        typeof metadata?.model_slug === "string" ? metadata.model_slug : "";
      addTurn(buckets, "codex", localDayKey(at), model);
      result.messages += 1;
    }
  }

  return finalize(result, buckets);
}

/**
 * Google Takeout → My Activity → Gemini Apps, JSON form: a flat array of
 * activity records with a `time` and a `title` like "Prompted Gemini".
 *
 * No model and no token counts, so these rows carry `turns` only — the
 * same honesty rule the Antigravity reader follows.
 */
export function parseGeminiTakeout(input: unknown): ImportResult {
  if (!Array.isArray(input)) {
    return empty("google", "expected a Takeout activity array");
  }
  const result = empty("google", "");
  result.reason = null;

  const buckets = new Map<string, Bucket>();
  for (const record of input) {
    if (!isObject(record)) {
      result.skipped += 1;
      continue;
    }
    const at = toDate(record.time ?? record.timestamp);
    if (!at) {
      result.skipped += 1;
      continue;
    }
    // Takeout logs both prompts and views; only a prompt is usage.
    const title = typeof record.title === "string" ? record.title : "";
    if (title && !/^Prompted\b/i.test(title)) continue;
    addTurn(buckets, "google", localDayKey(at), "");
    result.messages += 1;
  }

  return finalize(result, buckets);
}

/**
 * claude.ai's conversation export: an array of conversations, each with
 * a `chat_messages` array whose entries carry `sender` and `created_at`.
 */
export function parseClaudeExport(input: unknown): ImportResult {
  if (!Array.isArray(input)) {
    return empty("claude", "expected a conversations array");
  }
  const result = empty("claude", "");
  result.reason = null;

  const buckets = new Map<string, Bucket>();
  for (const conversation of input) {
    if (!isObject(conversation)) {
      result.skipped += 1;
      continue;
    }
    const messages = Array.isArray(conversation.chat_messages)
      ? conversation.chat_messages
      : null;
    if (!messages) {
      result.skipped += 1;
      continue;
    }
    for (const message of messages) {
      if (!isObject(message)) continue;
      if (message.sender !== "assistant") continue;
      const at = toDate(message.created_at);
      if (!at) {
        result.skipped += 1;
        continue;
      }
      addTurn(buckets, "claude", localDayKey(at), "");
      result.messages += 1;
    }
  }

  return finalize(result, buckets);
}

function addTurn(
  buckets: Map<string, Bucket>,
  provider: UsageProvider,
  day: string,
  model: string,
): void {
  const key = bucketKey(day, model);
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { row: emptyUsageRow(day, provider, "web", model) };
    buckets.set(key, bucket);
  }
  // Turns, never tokens. No export publishes token counts, and inventing
  // them from message length would be a confident wrong value.
  bucket.row.turns += 1;
}

function finalize(
  result: ImportResult,
  buckets: Map<string, Bucket>,
): ImportResult {
  const rows = [...buckets.values()].map((b) => b.row);
  if (rows.length === 0) return result;

  const days = rows.map((r) => r.day).sort();
  result.fromDay = days[0];
  result.toDay = days[days.length - 1];
  // Upsert, not replace-a-range: an export covers whatever window the
  // user happened to request, and clearing a range would delete web rows
  // an earlier, wider export had already established.
  result.rows = upsertUsageDaily(rows);
  return result;
}

export type ExportFormat = "chatgpt" | "gemini" | "claude";

/**
 * Guess the format from the payload's shape.
 *
 * Shape-sniffing rather than trusting a filename: the user drops
 * `conversations.json` from either Anthropic or OpenAI and those are
 * different formats under the same name.
 */
export function detectFormat(input: unknown): ExportFormat | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  const first = input.find(isObject);
  if (!first) return null;
  if ("mapping" in first) return "chatgpt";
  if ("chat_messages" in first) return "claude";
  if ("time" in first || "titleUrl" in first) return "gemini";
  return null;
}

export function importUsageExport(
  input: unknown,
  format?: ExportFormat,
): ImportResult {
  const resolved = format ?? detectFormat(input);
  switch (resolved) {
    case "chatgpt":
      return parseChatGptExport(input);
    case "gemini":
      return parseGeminiTakeout(input);
    case "claude":
      return parseClaudeExport(input);
    default:
      return empty(
        "claude",
        "unrecognized export format — expected a ChatGPT conversations.json, a claude.ai export, or a Gemini Takeout activity file",
      );
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
