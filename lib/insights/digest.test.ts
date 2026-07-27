import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetDbForTests, getDb } from "../db/index";
import { createBacklogItem, triageBacklogItem } from "../db/backlog";
import { emptyUsageRow, upsertUsageDaily } from "../db/usage";
import { recordQuotaSnapshot } from "../db/quota";
import { localDayKey } from "../util/day";
import {
  buildDigest,
  buildProposals,
  parseReply,
  renderDigest,
  replyIsExecutable,
} from "./digest";

const NOW = new Date(2026, 6, 26, 7, 0);

beforeEach(() => {
  _resetDbForTests();
  const dir = mkdtempSync(join(tmpdir(), "drydock-digest-"));
  process.env.DRYDOCK_DB_PATH = join(dir, "test.db");
  getDb();
});

function proposal(title: string, createdAt: number) {
  const item = createBacklogItem({
    title,
    source: "ai-generated",
    status: "proposed",
    created_at: createdAt,
  });
  return item;
}

describe("buildProposals", () => {
  it("numbers them 1..n, newest first", () => {
    // The number IS the reply token, so ordering has to be stable and
    // the newest idea — the one the user has context for — comes first.
    proposal("older idea", 1000);
    proposal("newer idea", 2000);
    const proposals = buildProposals();
    expect(proposals.map((p) => [p.n, p.title])).toEqual([
      [1, "newer idea"],
      [2, "older idea"],
    ]);
  });

  it("only lists untriaged proposals", () => {
    const accepted = proposal("already accepted", 3000);
    triageBacklogItem(accepted.id);
    proposal("still waiting", 2000);
    expect(buildProposals().map((p) => p.title)).toEqual(["still waiting"]);
  });

  it("caps the list", () => {
    for (let i = 0; i < 10; i += 1) proposal(`idea ${i}`, 1000 + i);
    expect(buildProposals()).toHaveLength(3);
  });
});

describe("renderDigest", () => {
  it("is plain text — iMessage renders no markdown", () => {
    proposal("permit tracker refresh", 2000);
    const text = renderDigest(buildDigest(NOW));
    expect(text).not.toMatch(/[*_`#]/);
  });

  it("numbers proposals and restates the reply grammar", () => {
    proposal("permit tracker refresh", 2000);
    const text = renderDigest(buildDigest(NOW));
    expect(text).toContain("(1) permit tracker refresh");
    // Nobody memorizes a grammar they use once a day, half-awake.
    expect(text).toContain("Reply: accept N / drop N / burn N / brief");
  });

  it("says nothing needs attention rather than staying silent", () => {
    const text = renderDigest(buildDigest(NOW));
    expect(text).toContain("Nothing needs attention");
  });

  it("reports token consumption when no quota percentage exists", () => {
    // Google has no sanctioned quota surface. Reporting consumption is
    // honest; inventing a percentage would not be.
    upsertUsageDaily([
      {
        ...emptyUsageRow(localDayKey(NOW), "claude", "cli", "claude-sonnet"),
        total_tokens: 2_500_000,
        turns: 40,
      },
    ]);
    const text = renderDigest(buildDigest(NOW));
    expect(text).toContain("2.5M tokens this week");
    expect(text).not.toMatch(/\d+%/);
  });

  it("shows a quota percentage WITH its age once it's stale", () => {
    upsertUsageDaily([
      {
        ...emptyUsageRow(localDayKey(NOW), "codex", "cli", "gpt-5.6-sol"),
        total_tokens: 1000,
        turns: 5,
      },
    ]);
    recordQuotaSnapshot({
      provider: "codex",
      window: "week",
      used_pct: 58,
      source: "app-server",
      // Four hours ago — on a phone that difference matters.
      captured_at: Math.floor(NOW.getTime() / 1000) - 4 * 3600,
    });
    const text = renderDigest(buildDigest(NOW));
    expect(text).toContain("58%");
    expect(text).toContain("4h old");
  });
});

describe("parseReply", () => {
  it("parses a multi-command reply", () => {
    const reply = parseReply("accept 2, burn 1");
    expect(reply.commands).toEqual([
      { action: "accept", n: 2 },
      { action: "burn", n: 1 },
    ]);
    expect(reply.unrecognized).toEqual([]);
  });

  it("accepts 'and', semicolons, newlines, and a stray #", () => {
    expect(parseReply("accept 1 and drop 2").commands).toHaveLength(2);
    expect(parseReply("accept 1; drop 2").commands).toHaveLength(2);
    expect(parseReply("accept #1").commands[0].n).toBe(1);
    expect(parseReply("ACCEPT 1").commands[0].action).toBe("accept");
  });

  it("parses a bare brief", () => {
    expect(parseReply("brief").commands).toEqual([
      { action: "brief", n: null },
    ]);
  });

  it("collects anything it doesn't understand rather than guessing", () => {
    // This runs on text typed one-handed from a lock screen, and the
    // actions mutate a real backlog. Asking again costs a message; a
    // wrong guess is silent and lands on the wrong item.
    const reply = parseReply("accept the second one please");
    expect(reply.commands).toEqual([]);
    expect(reply.unrecognized).toHaveLength(1);
  });

  it("survives garbage and empty input", () => {
    for (const bad of ["", "   ", "👍", "yes"]) {
      const reply = parseReply(bad);
      expect(reply.commands).toEqual([]);
    }
    expect(parseReply(undefined as unknown as string).commands).toEqual([]);
  });
});

describe("replyIsExecutable", () => {
  it("refuses a reply containing ANY unrecognized fragment", () => {
    // Partial execution of a garbled command is the worst outcome — the
    // user can't tell which half ran.
    proposal("an idea", 2000);
    const digest = buildDigest(NOW);
    const verdict = replyIsExecutable(
      parseReply("accept 1, do the other thing"),
      digest,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("didn't understand");
  });

  it("refuses a number the digest didn't offer", () => {
    // "accept 7" against a three-item digest is a typo, not an
    // instruction. Silently ignoring it would leave the user believing
    // something had been accepted.
    proposal("an idea", 2000);
    const digest = buildDigest(NOW);
    const verdict = replyIsExecutable(parseReply("accept 7"), digest);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("no item 7");
  });

  it("refuses an empty reply", () => {
    expect(replyIsExecutable(parseReply(""), buildDigest(NOW)).ok).toBe(false);
  });

  it("accepts a clean, in-range reply", () => {
    proposal("first", 3000);
    proposal("second", 2000);
    const digest = buildDigest(NOW);
    expect(replyIsExecutable(parseReply("accept 1, drop 2"), digest).ok).toBe(
      true,
    );
  });

  it("lets a bare brief through with no proposals at all", () => {
    expect(replyIsExecutable(parseReply("brief"), buildDigest(NOW)).ok).toBe(
      true,
    );
  });
});
