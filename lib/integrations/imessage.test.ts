import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetDbForTests, getDb } from "../db/index";
import { listBacklog } from "../db/backlog";
import { getSetting, setSetting } from "../db/settings";
import {
  DEFAULT_TRIGGER,
  ENABLED_KEY,
  LAST_ROWID_KEY,
  SELF_HANDLE_KEY,
  TRIGGER_KEY,
  imessageHealth,
  pollImessages,
  seedImessageCursor,
} from "./imessage";

/**
 * A synthetic `chat.db` in the real schema's shape. Building one rather
 * than reading the developer's actual messages: the tests need to assert
 * on specific content, and a test suite has no business opening a
 * personal message archive.
 */

let root: string;
let chatDb: string;
const SELF = "+15555550123";

beforeEach(() => {
  _resetDbForTests();
  root = mkdtempSync(join(tmpdir(), "drydock-imessage-"));
  process.env.DRYDOCK_DB_PATH = join(root, "drydock.db");
  chatDb = join(root, "chat.db");
  process.env.DRYDOCK_IMESSAGE_DB = chatDb;
  getDb();
  setSetting(ENABLED_KEY, "true");
  setSetting(SELF_HANDLE_KEY, SELF);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.DRYDOCK_IMESSAGE_DB;
});

interface Msg {
  text?: string | null;
  body?: string | null;
  fromMe?: boolean;
  handle?: string;
}

function buildChatDb(messages: Msg[]): void {
  const db = new Database(chatDb);
  db.prepare(
    `CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT)`,
  ).run();
  db.prepare(
    `CREATE TABLE message (
       ROWID INTEGER PRIMARY KEY,
       text TEXT,
       attributedBody BLOB,
       handle_id INTEGER,
       is_from_me INTEGER,
       date INTEGER
     )`,
  ).run();

  const handles = new Map<string, number>();
  const insertHandle = db.prepare(`INSERT INTO handle (id) VALUES (?)`);
  const insertMsg = db.prepare(
    `INSERT INTO message (text, attributedBody, handle_id, is_from_me, date)
     VALUES (?, ?, ?, ?, ?)`,
  );

  for (const msg of messages) {
    const handle = msg.handle ?? SELF;
    if (!handles.has(handle)) {
      handles.set(handle, Number(insertHandle.run(handle).lastInsertRowid));
    }
    insertMsg.run(
      msg.text ?? null,
      msg.body ? attributedBody(msg.body) : null,
      handles.get(handle)!,
      msg.fromMe === false ? 0 : 1,
      800_000_000 * 1_000_000_000,
    );
  }
  db.close();
}

/** Same framing as the real archive — see typedstream.test.ts. */
function attributedBody(text: string): Buffer {
  const body = Buffer.from(text, "utf8");
  return Buffer.concat([
    Buffer.from("\x04\x0bstreamtyped", "binary"),
    Buffer.from("\x84\x84\x84\x08NSString\x01\x95\x84\x01", "binary"),
    Buffer.from("+"),
    body.length > 0x80
      ? (() => {
          const b = Buffer.alloc(3);
          b[0] = 0x81;
          b.writeUInt16LE(body.length, 1);
          return b;
        })()
      : Buffer.from([body.length]),
    body,
  ]);
}

describe("imessageHealth", () => {
  it("is disabled until the user turns it on", () => {
    setSetting(ENABLED_KEY, "false");
    expect(imessageHealth().status).toBe("disabled");
  });

  it("refuses to guess the self-handle", () => {
    // A Mac has several handles; picking one silently would watch the
    // wrong thread and capture nothing, looking like a broken feature.
    setSetting(SELF_HANDLE_KEY, "");
    const health = imessageHealth();
    expect(health.status).toBe("disabled");
    expect(health.reason).toContain("self-handle");
  });

  it("names Full Disk Access when chat.db can't be opened", () => {
    // The file is visible without FDA and only the read fails, so a
    // presence check would report healthy on a machine that can never
    // read a message.
    const health = imessageHealth();
    expect(health.status).toBe("unavailable");
    expect(health.reason).toMatch(/chat\.db not found|Full Disk Access/);
  });

  it("is ok once the database is readable", () => {
    buildChatDb([{ text: "hi" }]);
    expect(imessageHealth().status).toBe("ok");
  });
});

describe("pollImessages", () => {
  it("captures only messages carrying the trigger prefix", () => {
    // Texting yourself a grocery list must not become a backlog item.
    buildChatDb([
      { text: "milk, eggs, bread" },
      { text: "idea: rate limit the tunnel endpoints" },
    ]);

    const result = pollImessages();
    expect(result.captured).toBe(1);
    expect(result.skipped).toBe(1);
    const [item] = listBacklog({ stage: "inbox" });
    // The prefix is stripped — it's addressing, not content.
    expect(item.title).toBe("rate limit the tunnel endpoints");
    expect(item.source).toBe("imessage");
  });

  it("decodes attributedBody when text is NULL", () => {
    // 52% of real messages are this shape. Reading only `text` would
    // silently miss half of everything the user sent.
    buildChatDb([{ text: null, body: "idea: decode the typedstream" }]);
    const result = pollImessages();
    expect(result.captured).toBe(1);
    expect(listBacklog({ stage: "inbox" })[0].title).toBe(
      "decode the typedstream",
    );
  });

  it("files an unreadable message rather than dropping it", () => {
    // A capture arrived. Saying so — with a pointer to Messages — is
    // honest; silently skipping loses a thought with no trace.
    const db = new Database(chatDb);
    db.prepare(`CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT)`).run();
    db.prepare(
      `CREATE TABLE message (ROWID INTEGER PRIMARY KEY, text TEXT,
        attributedBody BLOB, handle_id INTEGER, is_from_me INTEGER, date INTEGER)`,
    ).run();
    db.prepare(`INSERT INTO handle (id) VALUES (?)`).run(SELF);
    db.prepare(
      `INSERT INTO message (text, attributedBody, handle_id, is_from_me, date)
       VALUES (NULL, ?, 1, 1, 0)`,
    ).run(Buffer.from([0xde, 0xad, 0xbe, 0xef]));
    db.close();

    const result = pollImessages();
    expect(result.unreadable).toBe(1);
    expect(result.captured).toBe(1);
    expect(listBacklog({ stage: "inbox" })[0].title).toContain("unreadable");
  });

  it("ignores messages from other people and other threads", () => {
    buildChatDb([
      { text: "idea: from someone else", handle: "+15555559999" },
      { text: "idea: received on my own thread", fromMe: false },
      { text: "idea: mine" },
    ]);
    const result = pollImessages();
    expect(result.captured).toBe(1);
    expect(listBacklog({ stage: "inbox" })[0].title).toBe("mine");
  });

  it("advances the cursor so a poll never re-reads", () => {
    buildChatDb([{ text: "idea: one" }, { text: "idea: two" }]);
    const first = pollImessages();
    expect(first.captured).toBe(2);

    const second = pollImessages();
    expect(second.scanned).toBe(0);
    expect(listBacklog({ stage: "inbox" })).toHaveLength(2);
  });

  it("advances the cursor even when everything was skipped", () => {
    // Otherwise one non-trigger message is re-examined forever.
    buildChatDb([{ text: "just a normal message" }]);
    pollImessages();
    expect(getSetting(LAST_ROWID_KEY)).toBe("1");
    expect(pollImessages().scanned).toBe(0);
  });

  it("captures everything when the trigger is cleared", () => {
    setSetting(TRIGGER_KEY, "");
    buildChatDb([{ text: "no prefix here" }]);
    const result = pollImessages();
    expect(result.captured).toBe(1);
    expect(listBacklog({ stage: "inbox" })[0].title).toBe("no prefix here");
  });

  it("matches the trigger case-insensitively and skips an empty payload", () => {
    buildChatDb([{ text: "IDEA: shouting" }, { text: "idea:" }]);
    const result = pollImessages();
    expect(result.captured).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it("reports unavailable instead of throwing when the db is gone", () => {
    rmSync(chatDb, { force: true });
    const result = pollImessages();
    expect(result.status).toBe("unavailable");
    expect(result.captured).toBe(0);
  });

  it("lands captures in the INBOX, never the backlog", () => {
    buildChatDb([{ text: "idea: something" }]);
    pollImessages();
    expect(listBacklog({ stage: "triaged" })).toHaveLength(0);
  });
});

describe("seedImessageCursor", () => {
  it("skips history so enabling the channel doesn't import years of texts", () => {
    // Without this the first poll walks backwards through every message
    // that ever began with the trigger word — the "helpful" behaviour
    // that makes a user switch the feature straight back off.
    buildChatDb([
      { text: "idea: ancient one" },
      { text: "idea: ancient two" },
    ]);
    const seeded = seedImessageCursor();
    expect(seeded.ok).toBe(true);
    expect(seeded.rowid).toBe(2);

    expect(pollImessages().captured).toBe(0);
    expect(listBacklog()).toHaveLength(0);
  });

  it("reports failure rather than throwing when there's no database", () => {
    expect(seedImessageCursor()).toEqual({ ok: false, rowid: null });
  });
});

describe("defaults", () => {
  it("requires a prefix out of the box", () => {
    expect(DEFAULT_TRIGGER).toBe("idea:");
  });
});
