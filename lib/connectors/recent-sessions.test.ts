import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  utimesSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  cleanPrompt,
  collapseWorktreePath,
  readRecentSessions,
} from "./recent-sessions";

/**
 * Every root is passed explicitly and points into a temp fixture. Nothing
 * here may fall back to a default, because the defaults resolve to
 * `~/.claude`, `~/.codex` and `~/.gemini` — the developer's real
 * transcripts. A test that reads those is both non-deterministic and a
 * privacy problem.
 */

let root: string;

function ago(days: number): Date {
  return new Date(Date.now() - days * 86_400_000);
}

/** Write a JSONL file and stamp its mtime, which is the reader's filter. */
function writeLog(path: string, lines: unknown[], mtime: Date): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n"));
  utimesSync(path, mtime, mtime);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dd-recent-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function roots() {
  return {
    claudeRoot: join(root, "claude", "projects"),
    codexRoot: join(root, "codex", "sessions"),
    codexArchiveRoot: join(root, "codex", "archived_sessions"),
    antigravityRoot: join(root, "gemini", "brain"),
  };
}

describe("cleanPrompt", () => {
  it("strips the ambient blocks the CLIs inject around a real prompt", () => {
    const raw =
      '<in-app-browser-context source="ambient-ui-state">noise here</in-app-browser-context>\nfix the login bug';
    expect(cleanPrompt(raw)).toBe("fix the login bug");
  });

  it("returns null when nothing but machinery is left", () => {
    expect(cleanPrompt("<system-reminder>do a thing</system-reminder>")).toBeNull();
  });

  it("drops the file-attachment preamble Codex prepends", () => {
    const raw = "# Files mentioned by the user:\n\n## foo.png: /tmp/foo.png";
    expect(cleanPrompt(raw)).toBeNull();
  });

  it("truncates with an ellipsis rather than cutting mid-flow", () => {
    const out = cleanPrompt("x".repeat(400), 50);
    expect(out).toHaveLength(50);
    expect(out?.endsWith("…")).toBe(true);
  });
});

describe("collapseWorktreePath", () => {
  it("maps a DryDock worktree back to the project that owns it", () => {
    expect(
      collapseWorktreePath("/Users/p/Projects/DryDock/.claude/worktrees/feat-x"),
    ).toBe("/Users/p/Projects/DryDock");
  });

  it("leaves an ordinary path alone", () => {
    expect(collapseWorktreePath("/Users/p/Projects/DryDock")).toBe(
      "/Users/p/Projects/DryDock",
    );
  });
});

describe("readRecentSessions", () => {
  it("reads a Claude session's title, project, branch and last prompt", async () => {
    writeLog(
      join(roots().claudeRoot, "encoded", "sess-1.jsonl"),
      [
        {
          type: "user",
          timestamp: ago(1).toISOString(),
          cwd: "/Users/p/Projects/Thing",
          gitBranch: "feat/x",
          message: { role: "user", content: "make the button blue" },
        },
        { type: "ai-title", aiTitle: "Button colour work", sessionId: "sess-1" },
      ],
      ago(1),
    );

    const result = await readRecentSessions(roots());
    expect(result.sessions).toHaveLength(1);
    const [session] = result.sessions;
    expect(session.tool).toBe("claude");
    expect(session.id).toBe("sess-1");
    expect(session.title).toBe("Button colour work");
    expect(session.project).toBe("Thing");
    expect(session.branch).toBe("feat/x");
    expect(session.lastPrompt).toBe("make the button blue");
  });

  it("prefers a custom title over the generated one", async () => {
    writeLog(
      join(roots().claudeRoot, "e", "s.jsonl"),
      [
        { type: "user", timestamp: ago(1).toISOString(), cwd: "/p/A", message: { content: "hi there" } },
        { type: "ai-title", aiTitle: "Generated" },
        { type: "custom-title", customTitle: "What I called it" },
      ],
      ago(1),
    );
    const { sessions } = await readRecentSessions(roots());
    expect(sessions[0].title).toBe("What I called it");
  });

  it("never treats an injected `isMeta` turn as something the user typed", async () => {
    writeLog(
      join(roots().claudeRoot, "e", "s.jsonl"),
      [
        {
          type: "user",
          timestamp: ago(1).toISOString(),
          cwd: "/p/A",
          message: { content: "the real question" },
        },
        {
          type: "user",
          isMeta: true,
          timestamp: ago(1).toISOString(),
          message: { content: "injected hook output nobody asked for" },
        },
      ],
      ago(1),
    );
    const { sessions } = await readRecentSessions(roots());
    expect(sessions[0].lastPrompt).toBe("the real question");
  });

  it("excludes subagent transcripts — they are children of a session, not sessions", async () => {
    const claude = roots().claudeRoot;
    writeLog(
      join(claude, "e", "parent.jsonl"),
      [{ type: "user", timestamp: ago(1).toISOString(), cwd: "/p/A", message: { content: "parent work" } }],
      ago(1),
    );
    writeLog(
      join(claude, "e", "parent", "subagents", "agent-1.jsonl"),
      [{ type: "user", timestamp: ago(1).toISOString(), cwd: "/p/A", message: { content: "child work" } }],
      ago(1),
    );

    const { sessions } = await readRecentSessions(roots());
    expect(sessions.map((s) => s.id)).toEqual(["parent"]);
  });

  it("excludes files older than the window but still reports when the tool was last used", async () => {
    writeLog(
      join(roots().claudeRoot, "e", "old.jsonl"),
      [{ type: "user", timestamp: ago(90).toISOString(), cwd: "/p/A", message: { content: "ancient" } }],
      ago(90),
    );

    const result = await readRecentSessions({ ...roots(), windowDays: 14 });
    expect(result.sessions).toHaveLength(0);
    const claude = result.tools.find((t) => t.tool === "claude");
    // The distinction that matters: idle is not absent.
    expect(claude?.health).toBe("ok");
    expect(claude?.filesRead).toBe(0);
    expect(claude?.lastActiveAt).not.toBeNull();
  });

  it("reports a tool with no logs as missing rather than silently empty", async () => {
    const result = await readRecentSessions(roots());
    for (const tool of result.tools) expect(tool.health).toBe("missing");
    expect(result.sessions).toHaveLength(0);
  });

  it("reads a Codex rollout's id, cwd and prompts", async () => {
    writeLog(
      join(roots().codexRoot, "2026", "rollout-a.jsonl"),
      [
        {
          timestamp: ago(2).toISOString(),
          type: "session_meta",
          payload: { session_id: "codex-1", cwd: "/Users/p/Projects/Nuke" },
        },
        {
          timestamp: ago(2).toISOString(),
          type: "event_msg",
          payload: { type: "user_message", message: "build the tracker" },
        },
      ],
      ago(2),
    );

    const { sessions } = await readRecentSessions(roots());
    expect(sessions).toHaveLength(1);
    expect(sessions[0].tool).toBe("codex");
    expect(sessions[0].id).toBe("codex-1");
    expect(sessions[0].project).toBe("Nuke");
    expect(sessions[0].lastPrompt).toBe("build the tracker");
  });

  it("folds in the Codex archive, which is a sibling directory not a child", async () => {
    writeLog(
      join(roots().codexArchiveRoot, "rollout-old.jsonl"),
      [
        {
          timestamp: ago(3).toISOString(),
          type: "session_meta",
          payload: { session_id: "archived-1", cwd: "/p/Arch" },
        },
        {
          timestamp: ago(3).toISOString(),
          type: "event_msg",
          payload: { type: "user_message", message: "archived work" },
        },
      ],
      ago(3),
    );

    const { sessions } = await readRecentSessions(roots());
    expect(sessions.map((s) => s.id)).toContain("archived-1");
  });

  it("reads an Antigravity transcript's USER_REQUEST, ignoring transcript_full", async () => {
    const logs = join(roots().antigravityRoot, "conv-9", ".system_generated", "logs");
    const step = {
      step_index: 0,
      type: "USER_INPUT",
      created_at: ago(4).toISOString(),
      content: "<USER_REQUEST>\nreview the PR\n</USER_REQUEST>\n<META>x</META>",
    };
    writeLog(join(logs, "transcript.jsonl"), [step], ago(4));
    writeLog(join(logs, "transcript_full.jsonl"), [step], ago(4));

    const { sessions } = await readRecentSessions(roots());
    // Exactly one — reading both files would list the conversation twice.
    expect(sessions).toHaveLength(1);
    expect(sessions[0].tool).toBe("antigravity");
    expect(sessions[0].id).toBe("conv-9");
    expect(sessions[0].title).toBe("review the PR");
  });

  it("sorts newest first across all three tools", async () => {
    writeLog(
      join(roots().claudeRoot, "e", "c.jsonl"),
      [{ type: "user", timestamp: ago(5).toISOString(), cwd: "/p/A", message: { content: "claude old" } }],
      ago(5),
    );
    writeLog(
      join(roots().codexRoot, "d", "rollout-b.jsonl"),
      [
        { timestamp: ago(1).toISOString(), type: "session_meta", payload: { session_id: "cx", cwd: "/p/B" } },
        { timestamp: ago(1).toISOString(), type: "event_msg", payload: { type: "user_message", message: "codex new" } },
      ],
      ago(1),
    );

    const { sessions } = await readRecentSessions(roots());
    expect(sessions.map((s) => s.tool)).toEqual(["codex", "claude"]);
  });

  it("collapses repeated runs of the same scheduled job to the newest", async () => {
    for (const day of [1, 2, 3]) {
      writeLog(
        join(roots().claudeRoot, "e", `sweep-${day}.jsonl`),
        [
          { type: "user", timestamp: ago(day).toISOString(), cwd: "/p/Repo", message: { content: "run" } },
          { type: "custom-title", customTitle: "Drydock daily" },
        ],
        ago(day),
      );
    }

    const { sessions } = await readRecentSessions(roots());
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("sweep-1");
  });
});

describe("traversal failures are never reported as absence", () => {
  it("reports an unreadable root as error, not 'no logs on this machine'", async () => {
    // The distinction that matters: `missing` renders as "this tool isn't
    // installed", which is a confident wrong answer when the truth is that
    // the directory refused to be read.
    const claudeRoot = join(root, "claude", "projects");
    mkdirSync(claudeRoot, { recursive: true });
    chmodSync(claudeRoot, 0o000);
    try {
      const result = await readRecentSessions({ ...roots() });
      const claude = result.tools.find((t) => t.tool === "claude");
      expect(claude?.health).toBe("error");
      expect(claude?.reason).toBeTruthy();
    } finally {
      chmodSync(claudeRoot, 0o755);
    }
  });

  it("marks a partial read with a reason while still returning what it read", async () => {
    const claudeRoot = roots().claudeRoot;
    writeLog(
      join(claudeRoot, "readable", "s.jsonl"),
      [{ type: "user", timestamp: ago(1).toISOString(), cwd: "/p/A", message: { content: "found me" } }],
      ago(1),
    );
    const blocked = join(claudeRoot, "blocked");
    mkdirSync(blocked, { recursive: true });
    chmodSync(blocked, 0o000);
    try {
      const result = await readRecentSessions({ ...roots() });
      const claude = result.tools.find((t) => t.tool === "claude");
      // Real sessions came back, so health stays ok — but it must say the
      // answer is incomplete.
      expect(claude?.health).toBe("ok");
      expect(result.sessions).toHaveLength(1);
      expect(claude?.reason).toMatch(/could not be read/);
    } finally {
      chmodSync(blocked, 0o755);
    }
  });
});
