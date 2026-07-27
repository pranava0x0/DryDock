import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetDbForTests, getDb } from "../db/index";
import { listUsageDaily } from "../db/usage";
import { localDayKey } from "../util/day";
import {
  detectFormat,
  importUsageExport,
  parseChatGptExport,
  parseClaudeExport,
  parseGeminiTakeout,
  toDate,
} from "./usage-imports";

beforeEach(() => {
  _resetDbForTests();
  const dir = mkdtempSync(join(tmpdir(), "drydock-import-"));
  process.env.DRYDOCK_DB_PATH = join(dir, "test.db");
  getDb();
});

/** A local wall-clock time, as the exports would encode it. */
const AT = new Date(2026, 6, 20, 14, 30);
const DAY = localDayKey(AT);

function chatgpt(messages: Array<Record<string, unknown>>) {
  return [
    {
      title: "a conversation",
      mapping: Object.fromEntries(
        messages.map((m, i) => [`node-${i}`, { message: m }]),
      ),
    },
  ];
}

describe("toDate", () => {
  it("accepts seconds, milliseconds, and ISO strings", () => {
    const seconds = Math.floor(AT.getTime() / 1000);
    expect(toDate(seconds)!.getTime()).toBe(seconds * 1000);
    expect(toDate(AT.getTime())!.getTime()).toBe(AT.getTime());
    expect(toDate(AT.toISOString())!.getTime()).toBe(AT.getTime());
  });

  it("returns null rather than an Invalid Date", () => {
    for (const bad of [null, undefined, "", "nonsense", 0, -1, {}]) {
      expect(toDate(bad)).toBeNull();
    }
  });
});

describe("parseChatGptExport", () => {
  it("counts assistant turns per day and per model", () => {
    const result = parseChatGptExport(
      chatgpt([
        {
          author: { role: "user" },
          create_time: AT.getTime() / 1000,
        },
        {
          author: { role: "assistant" },
          create_time: AT.getTime() / 1000,
          metadata: { model_slug: "gpt-5.6" },
        },
        {
          author: { role: "assistant" },
          create_time: AT.getTime() / 1000,
          metadata: { model_slug: "gpt-5.6" },
        },
      ]),
    );

    // The user's own turns are excluded — counting both would double
    // every exchange, and the question is "how much model time".
    expect(result.messages).toBe(2);
    const rows = listUsageDaily();
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe("codex");
    expect(rows[0].surface).toBe("web");
    expect(rows[0].model).toBe("gpt-5.6");
    expect(rows[0].turns).toBe(2);
    // No export publishes token counts; inventing them would be a
    // confident wrong value.
    expect(rows[0].total_tokens).toBe(0);
  });

  it("skips unreadable records and REPORTS the count", () => {
    // A silent partial import looks like a quiet month rather than a
    // broken parser.
    const result = parseChatGptExport([
      { mapping: { a: { message: { author: { role: "assistant" } } } } },
      "not an object",
      { noMapping: true },
    ]);
    expect(result.skipped).toBeGreaterThan(0);
  });

  it("tolerates a message with no model slug", () => {
    const result = parseChatGptExport(
      chatgpt([
        { author: { role: "assistant" }, create_time: AT.getTime() / 1000 },
      ]),
    );
    expect(result.messages).toBe(1);
    expect(listUsageDaily()[0].model).toBe("");
  });

  it("rejects a non-array payload with a reason", () => {
    expect(parseChatGptExport({ nope: true }).reason).toContain("array");
  });
});

describe("parseGeminiTakeout", () => {
  it("counts prompts and ignores non-prompt activity", () => {
    const result = parseGeminiTakeout([
      { title: "Prompted Gemini", time: AT.toISOString() },
      { title: "Viewed Gemini", time: AT.toISOString() },
      { title: "Prompted Gemini", time: AT.toISOString() },
    ]);
    expect(result.messages).toBe(2);
    const [row] = listUsageDaily();
    expect(row.provider).toBe("google");
    expect(row.turns).toBe(2);
    expect(row.total_tokens).toBe(0);
  });
});

describe("parseClaudeExport", () => {
  it("counts assistant messages across conversations", () => {
    const result = parseClaudeExport([
      {
        chat_messages: [
          { sender: "human", created_at: AT.toISOString() },
          { sender: "assistant", created_at: AT.toISOString() },
        ],
      },
      {
        chat_messages: [{ sender: "assistant", created_at: AT.toISOString() }],
      },
    ]);
    expect(result.messages).toBe(2);
    expect(listUsageDaily()[0].provider).toBe("claude");
  });
});

describe("detectFormat", () => {
  it("sniffs the shape rather than trusting a filename", () => {
    // Anthropic and OpenAI both ship a file called conversations.json.
    expect(detectFormat(chatgpt([]))).toBe("chatgpt");
    expect(detectFormat([{ chat_messages: [] }])).toBe("claude");
    expect(detectFormat([{ time: AT.toISOString(), title: "Prompted" }])).toBe(
      "gemini",
    );
  });

  it("returns null for anything unrecognized", () => {
    expect(detectFormat([])).toBeNull();
    expect(detectFormat([{ something: "else" }])).toBeNull();
    expect(detectFormat("nope")).toBeNull();
  });
});

describe("importUsageExport", () => {
  it("is idempotent — re-importing overwrites rather than doubling", () => {
    const payload = chatgpt([
      {
        author: { role: "assistant" },
        create_time: AT.getTime() / 1000,
        metadata: { model_slug: "gpt-5.6" },
      },
    ]);
    importUsageExport(payload);
    importUsageExport(payload);

    const rows = listUsageDaily();
    expect(rows).toHaveLength(1);
    expect(rows[0].turns).toBe(1);
  });

  it("reports the window it covered, for provenance", () => {
    const result = importUsageExport(
      chatgpt([
        { author: { role: "assistant" }, create_time: AT.getTime() / 1000 },
      ]),
    );
    expect(result.fromDay).toBe(DAY);
    expect(result.toDay).toBe(DAY);
  });

  it("says what it expected when the format is unrecognized", () => {
    const result = importUsageExport([{ mystery: 1 }]);
    expect(result.rows).toBe(0);
    expect(result.reason).toContain("unrecognized export format");
  });

  it("keeps web rows separate from CLI rows", () => {
    // `surface` is part of the primary key, so an import can never
    // clobber what the local collectors wrote.
    importUsageExport(
      chatgpt([
        { author: { role: "assistant" }, create_time: AT.getTime() / 1000 },
      ]),
    );
    expect(listUsageDaily()[0].surface).toBe("web");
  });
});
