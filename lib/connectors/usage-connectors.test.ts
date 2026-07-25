import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetDbForTests, getDb } from "../db/index";
import { listUsageDaily, upsertUsageDaily, emptyUsageRow } from "../db/usage";
import { localDayKey } from "../util/day";
import { getCursor, getLastSyncAt } from "./watermark";
import {
  _resetConnectorStateForTests,
  antigravityLocalConnector,
  claudeLocalConnector,
  codexLocalConnector,
} from "./usage-connectors";

/**
 * End-to-end for the collect loop: fixture logs on disk → ledger rows in
 * SQLite, with the watermark and health semantics the dashboard depends
 * on.
 */

let home: string;
let claudeDir: string;
let codexDir: string;
let brainDir: string;

/**
 * Local ISO for a given local wall-clock time. The providers write UTC
 * `Z` timestamps, so a fixture built from a local time has to be
 * converted — writing a naive `2026-07-20T10:00:00Z` would land on a
 * different local day depending on where the suite runs, which is the
 * exact bug the local-day bucketing exists to prevent.
 */
function localIso(
  y: number,
  m: number,
  d: number,
  hh: number,
  mm = 0,
): string {
  return new Date(y, m - 1, d, hh, mm).toISOString();
}

beforeEach(() => {
  _resetDbForTests();
  _resetConnectorStateForTests();
  home = mkdtempSync(join(tmpdir(), "drydock-connector-"));
  process.env.DRYDOCK_DB_PATH = join(home, "test.db");

  claudeDir = join(home, "claude-projects");
  codexDir = join(home, "codex", "sessions");
  brainDir = join(home, "brain");
  process.env.DRYDOCK_CLAUDE_PROJECTS_DIR = claudeDir;
  process.env.DRYDOCK_CODEX_SESSIONS_DIR = codexDir;
  process.env.DRYDOCK_ANTIGRAVITY_BRAIN_DIR = brainDir;
  getDb();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.DRYDOCK_CLAUDE_PROJECTS_DIR;
  delete process.env.DRYDOCK_CODEX_SESSIONS_DIR;
  delete process.env.DRYDOCK_ANTIGRAVITY_BRAIN_DIR;
});

function writeClaudeSession(
  encodedDir: string,
  sessionId: string,
  lines: unknown[],
): void {
  const dir = join(claudeDir, encodedDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${sessionId}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
}

function claudeTurn(opts: {
  sessionId: string;
  ts: string;
  cwd: string;
  model: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  branch?: string;
}) {
  return {
    type: "assistant",
    sessionId: opts.sessionId,
    timestamp: opts.ts,
    cwd: opts.cwd,
    gitBranch: opts.branch ?? "main",
    message: {
      model: opts.model,
      usage: {
        input_tokens: opts.input ?? 0,
        output_tokens: opts.output ?? 0,
        cache_read_input_tokens: opts.cacheRead ?? 0,
        cache_creation_input_tokens: 0,
      },
    },
  };
}

describe("claude-local connector", () => {
  it("writes per-day, per-model, per-project rows from the session logs", async () => {
    writeClaudeSession("-Users-me-Projects-DryDock", "sess-1", [
      claudeTurn({
        sessionId: "sess-1",
        ts: localIso(2026, 7, 20, 10),
        cwd: "/Users/me/Projects/DryDock",
        model: "claude-fable-5",
        input: 100,
        output: 50,
        cacheRead: 1000,
      }),
      claudeTurn({
        sessionId: "sess-1",
        ts: localIso(2026, 7, 20, 11),
        cwd: "/Users/me/Projects/DryDock",
        model: "claude-sonnet",
        input: 7,
        output: 3,
      }),
    ]);

    const result = await claudeLocalConnector.collect({ force: true });
    expect(result.status).toBe("ok");

    const rows = listUsageDaily({ provider: "claude" });
    expect(rows).toHaveLength(2);
    const fable = rows.find((r) => r.model === "claude-fable-5")!;
    expect(fable.day).toBe("2026-07-20");
    expect(fable.project_key).toBe("DryDock");
    expect(fable.input_tokens).toBe(100);
    expect(fable.cached_tokens).toBe(1000);
    // Cache tokens are real tokens the caps count — leaving them out of
    // the total would understate a heavy day by an order of magnitude.
    expect(fable.total_tokens).toBe(1150);
    expect(fable.turns).toBe(1);
    expect(fable.sessions).toBe(1);
  });

  it("attributes a worktree session to its parent project", async () => {
    // Every DryDock-dispatched task runs in a worktree; without the
    // collapse each task would show up as its own project.
    writeClaudeSession("-Users-me-Projects-DryDock--claude-worktrees-x", "s", [
      claudeTurn({
        sessionId: "s",
        ts: localIso(2026, 7, 20, 10),
        cwd: "/Users/me/Projects/DryDock/.claude/worktrees/ep10-abc123",
        model: "claude-sonnet",
        input: 5,
      }),
    ]);

    await claudeLocalConnector.collect({ force: true });
    expect(listUsageDaily()[0].project_key).toBe("DryDock");
  });

  it("keeps a spaced project name intact instead of decoding the directory", async () => {
    // The dash collision: the encoded dir says "Robotics-Leadership",
    // which naively decodes to a project called "Robotics".
    writeClaudeSession(
      "-Users-me-Projects-Robotics-Leadership--claude-worktrees-x",
      "s",
      [
        claudeTurn({
          sessionId: "s",
          ts: localIso(2026, 7, 20, 10),
          cwd: "/Users/me/Projects/Robotics Leadership/.claude/worktrees/x",
          model: "claude-sonnet",
          input: 5,
        }),
      ],
    );

    await claudeLocalConnector.collect({ force: true });
    expect(listUsageDaily()[0].project_key).toBe("Robotics Leadership");
  });

  it("buckets a late-evening turn into the LOCAL day", async () => {
    // 23:30 local is already tomorrow in UTC for negative offsets. The
    // row must read as the day the user experienced.
    writeClaudeSession("-p", "s", [
      claudeTurn({
        sessionId: "s",
        ts: localIso(2026, 7, 20, 23, 30),
        cwd: "/Users/me/Projects/DryDock",
        model: "claude-sonnet",
        input: 1,
      }),
    ]);

    await claudeLocalConnector.collect({ force: true });
    expect(listUsageDaily()[0].day).toBe("2026-07-20");
  });

  it("is idempotent — collecting twice does not double the tokens", async () => {
    writeClaudeSession("-p", "s", [
      claudeTurn({
        sessionId: "s",
        ts: localIso(2026, 7, 20, 10),
        cwd: "/Users/me/Projects/DryDock",
        model: "claude-sonnet",
        input: 100,
      }),
    ]);

    await claudeLocalConnector.collect({ force: true });
    await claudeLocalConnector.collect({ force: true });

    const rows = listUsageDaily();
    expect(rows).toHaveLength(1);
    expect(rows[0].input_tokens).toBe(100);
  });

  it("advances the cursor to yesterday, not today", async () => {
    // A turn at 23:59:58 can be flushed after midnight; a cursor of
    // "today" would freeze yesterday's total a couple of seconds early
    // and lose the tail of a late night permanently.
    writeClaudeSession("-p", "s", [
      claudeTurn({
        sessionId: "s",
        ts: localIso(2026, 7, 20, 10),
        cwd: "/Users/me/Projects/DryDock",
        model: "claude-sonnet",
        input: 1,
      }),
    ]);

    const now = new Date(2026, 6, 21, 9, 0);
    await claudeLocalConnector.collect({ force: true, now });
    expect(getCursor("claude-local")).toBe("2026-07-20");
    expect(getLastSyncAt("claude-local")).toBe(
      Math.floor(now.getTime() / 1000),
    );
  });

  it("skips the walk while the TTL is fresh", async () => {
    writeClaudeSession("-p", "s", [
      claudeTurn({
        sessionId: "s",
        ts: localIso(2026, 7, 20, 10),
        cwd: "/Users/me/Projects/DryDock",
        model: "claude-sonnet",
        input: 1,
      }),
    ]);
    const now = new Date(2026, 6, 21, 9, 0);
    await claudeLocalConnector.collect({ force: true, now });

    const second = await claudeLocalConnector.collect({
      now: new Date(now.getTime() + 5_000),
    });
    expect(second.skipped).toBe(true);
    expect(second.rowsWritten).toBe(0);
  });

  it("reports unavailable — and preserves history — when the source is gone", async () => {
    // The important one: an uninstalled provider must not blank the
    // ledger it filled while it was installed.
    upsertUsageDaily([
      { ...emptyUsageRow("2026-07-01", "claude", "cli"), total_tokens: 999 },
    ]);
    process.env.DRYDOCK_CLAUDE_PROJECTS_DIR = join(home, "nope");

    const result = await claudeLocalConnector.collect({ force: true });
    expect(result.status).toBe("unavailable");
    expect(result.reason).toContain("Claude Code has not run");
    expect(listUsageDaily()[0].total_tokens).toBe(999);
  });

  it("shares one walk between concurrent callers", async () => {
    writeClaudeSession("-p", "s", [
      claudeTurn({
        sessionId: "s",
        ts: localIso(2026, 7, 20, 10),
        cwd: "/Users/me/Projects/DryDock",
        model: "claude-sonnet",
        input: 1,
      }),
    ]);
    const [a, b] = await Promise.all([
      claudeLocalConnector.collect({ force: true }),
      claudeLocalConnector.collect({ force: true }),
    ]);
    // Same promise, so identical result objects — not two disk walks.
    expect(a).toBe(b);
  });

  it("health says 'not collected yet' rather than pretending ok", async () => {
    const health = await claudeLocalConnector.health();
    expect(health.status).toBe("unavailable");
    expect(health.reason).toBe("not collected yet");
    expect(health.lastSyncAt).toBeNull();
  });
});

describe("codex-local connector", () => {
  function writeRollout(
    dateParts: [string, string, string],
    name: string,
    lines: unknown[],
  ): void {
    const dir = join(codexDir, ...dateParts);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, name),
      lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    );
  }

  it("splits usage by the model carried in turn_context", async () => {
    // The plan assumed Codex usage couldn't be split by model. It can —
    // turn_context carries `model` and `cwd`, and precedes the
    // token_count events for the turns it configures.
    writeRollout(["2026", "07", "20"], "rollout-a.jsonl", [
      {
        timestamp: localIso(2026, 7, 20, 9),
        type: "session_meta",
        payload: {
          type: "session_meta",
          cwd: "/Users/me/Projects/FirstPassRx",
        },
      },
      {
        timestamp: localIso(2026, 7, 20, 10),
        type: "turn_context",
        payload: { model: "gpt-5.6-sol", cwd: "/Users/me/Projects/FirstPassRx" },
      },
      {
        timestamp: localIso(2026, 7, 20, 10, 1),
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 10,
              cached_input_tokens: 5,
              output_tokens: 20,
              reasoning_output_tokens: 8,
              total_tokens: 43,
            },
            total_token_usage: { input_tokens: 99999 },
          },
        },
      },
    ]);

    await codexLocalConnector.collect({ force: true });
    const rows = listUsageDaily({ provider: "codex" });
    expect(rows).toHaveLength(1);
    expect(rows[0].model).toBe("gpt-5.6-sol");
    expect(rows[0].project_key).toBe("FirstPassRx");
    expect(rows[0].reasoning_tokens).toBe(8);
    // The per-turn delta, never the cumulative total_token_usage.
    expect(rows[0].total_tokens).toBe(43);
  });

  it("leaves model empty (not guessed) when no turn_context exists", async () => {
    writeRollout(["2026", "07", "20"], "rollout-old.jsonl", [
      {
        timestamp: localIso(2026, 7, 20, 10),
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { last_token_usage: { input_tokens: 1, total_tokens: 1 } },
        },
      },
    ]);

    await codexLocalConnector.collect({ force: true });
    expect(listUsageDaily({ provider: "codex" })[0].model).toBe("");
  });

  it("includes archived sessions in the ledger", async () => {
    const archived = join(home, "codex", "archived_sessions");
    mkdirSync(archived, { recursive: true });
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(
      join(archived, "rollout-old.jsonl"),
      JSON.stringify({
        timestamp: localIso(2026, 7, 20, 10),
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { last_token_usage: { input_tokens: 42, total_tokens: 42 } },
        },
      }) + "\n",
    );

    await codexLocalConnector.collect({ force: true });
    expect(listUsageDaily({ provider: "codex" })[0].input_tokens).toBe(42);
  });
});

describe("antigravity-local connector", () => {
  function writeConversation(convId: string, steps: unknown[]): void {
    const dir = join(brainDir, convId, ".system_generated", "logs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "transcript.jsonl"),
      steps.map((s) => JSON.stringify(s)).join("\n") + "\n",
    );
  }

  it("records activity events with all token columns at zero", async () => {
    // Google persists no token counts anywhere. A row that claimed
    // tokens here would be fabricated; a token total that swallowed
    // these rows would read as "you used Google for nothing".
    writeConversation("conv-a", [
      { type: "USER_INPUT", created_at: localIso(2026, 7, 20, 10) },
      { type: "PLANNER_RESPONSE", created_at: localIso(2026, 7, 20, 10, 1) },
      { type: "VIEW_FILE", created_at: localIso(2026, 7, 20, 10, 2) },
    ]);

    await antigravityLocalConnector.collect({ force: true });
    const rows = listUsageDaily({ provider: "google" });
    expect(rows).toHaveLength(1);
    expect(rows[0].events).toBe(3);
    expect(rows[0].turns).toBe(1); // PLANNER_RESPONSE only
    expect(rows[0].total_tokens).toBe(0);
    expect(rows[0].input_tokens).toBe(0);
    expect(rows[0].model).toBe("");
    expect(rows[0].project_key).toBe("");
  });

  it("counts distinct conversations per day", async () => {
    writeConversation("a", [
      { type: "USER_INPUT", created_at: localIso(2026, 7, 20, 10) },
    ]);
    writeConversation("b", [
      { type: "USER_INPUT", created_at: localIso(2026, 7, 20, 11) },
    ]);
    await antigravityLocalConnector.collect({ force: true });
    expect(listUsageDaily({ provider: "google" })[0].sessions).toBe(2);
  });

  it("reports unavailable when Antigravity has never run", async () => {
    const result = await antigravityLocalConnector.collect({ force: true });
    expect(result.status).toBe("unavailable");
    expect(listUsageDaily({ provider: "google" })).toHaveLength(0);
  });
});

describe("cross-connector", () => {
  it("one provider's collect never clears another's rows", async () => {
    writeClaudeSession("-p", "s", [
      claudeTurn({
        sessionId: "s",
        ts: localIso(2026, 7, 20, 10),
        cwd: "/Users/me/Projects/DryDock",
        model: "claude-sonnet",
        input: 1,
      }),
    ]);
    upsertUsageDaily([
      {
        ...emptyUsageRow(localDayKey(new Date(2026, 6, 20)), "codex", "cli"),
        total_tokens: 7,
      },
    ]);

    await claudeLocalConnector.collect({ force: true });
    expect(listUsageDaily({ provider: "codex" })).toHaveLength(1);
    expect(listUsageDaily({ provider: "claude" })).toHaveLength(1);
  });
});

describe("connector health describes the source, not the slice", () => {
  it("stays ok when an incremental collect finds nothing new", async () => {
    // The bug this pins: after the first collect the cursor sits at
    // yesterday, so a re-collect on a day the user didn't touch Codex
    // legitimately produces zero rows. Reporting that as "no-data" put a
    // ⚠ badge on a card showing 312M tokens.
    writeClaudeSession("-p", "s", [
      claudeTurn({
        sessionId: "s",
        ts: localIso(2026, 7, 20, 10),
        cwd: "/Users/me/Projects/DryDock",
        model: "claude-sonnet",
        input: 100,
      }),
    ]);

    const first = await claudeLocalConnector.collect({
      force: true,
      now: new Date(2026, 6, 21, 9),
    });
    expect(first.status).toBe("ok");

    // Walk the cursor forward past the data. The third collect scans a
    // range containing no turns at all and writes nothing — the state
    // that used to report "no-data" and badge a populated card.
    await claudeLocalConnector.collect({
      force: true,
      now: new Date(2026, 6, 23, 9),
    });
    const third = await claudeLocalConnector.collect({
      force: true,
      now: new Date(2026, 6, 25, 9),
    });
    expect(third.rowsWritten).toBe(0);
    expect(third.status).toBe("ok");
    expect((await claudeLocalConnector.health()).status).toBe("ok");
    // And the history is still there — an empty incremental slice must
    // never look like a reason to forget what was already collected.
    expect(listUsageDaily({ provider: "claude" })).toHaveLength(1);
  });

  it("says no-data only when the source has never produced anything", async () => {
    mkdirSync(claudeDir, { recursive: true });
    const result = await claudeLocalConnector.collect({ force: true });
    expect(result.status).toBe("no-data");
    expect(result.reason).toContain("never recorded");
  });
});
