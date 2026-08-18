import { describe, expect, it } from "vitest";
import { buildNextUp } from "./next-up";
import type { RecentSession } from "@/lib/connectors/recent-sessions.types";
import type { OverviewTodo } from "./overview";

const NOW = new Date("2026-08-13T12:00:00Z");

function session(overrides: Partial<RecentSession> = {}): RecentSession {
  return {
    tool: "claude",
    id: "s1",
    title: "Refactor the settings page",
    lastPrompt: "split the provider card out",
    cwd: "/p/App",
    project: "App",
    branch: "feat/settings",
    startedAt: "2026-08-13T09:00:00Z",
    endedAt: "2026-08-13T10:00:00Z",
    ...overrides,
  };
}

function todo(overrides: Partial<OverviewTodo> = {}): OverviewTodo {
  return {
    kind: "pr",
    key: "o/r#1",
    title: "Add the thing",
    url: "https://github.com/o/r/pull/1",
    repository: "o/r",
    number: 1,
    label: "open",
    updatedAt: "2026-08-10T12:00:00Z",
    ageDays: 3,
    ...overrides,
  };
}

describe("buildNextUp", () => {
  it("puts a just-worked-on session first, above any open PR", () => {
    const result = buildNextUp({
      sessions: [session()],
      todos: [todo()],
      todosAvailable: true,
      todosReason: null,
      now: NOW,
    });
    expect(result.items[0].kind).toBe("resume");
    expect(result.items[0].title).toBe("Refactor the settings page");
    expect(result.items[1].kind).toBe("review");
  });

  it("explains its reasoning on every row", () => {
    const result = buildNextUp({
      sessions: [session()],
      todos: [todo({ ageDays: 9 })],
      todosAvailable: true,
      todosReason: null,
      now: NOW,
    });
    for (const item of result.items) expect(item.why).toBeTruthy();
    expect(result.items[1].why).toContain("9d");
  });

  it("does not suggest resuming a scheduled run", () => {
    // The nightly sweep is the most frequent thing in the log and the one
    // thing you never chose to do.
    const result = buildNextUp({
      sessions: [session({ title: "Drydock daily sweep" })],
      todos: [todo()],
      todosAvailable: true,
      todosReason: null,
      now: NOW,
    });
    expect(result.items.some((i) => i.kind === "resume")).toBe(false);
    expect(result.items[0].kind).toBe("review");
  });

  it("does not suggest resuming a session from days ago", () => {
    const result = buildNextUp({
      sessions: [session({ endedAt: "2026-08-09T10:00:00Z" })],
      todos: [],
      todosAvailable: true,
      todosReason: null,
      now: NOW,
    });
    expect(result.items).toHaveLength(0);
  });

  it("drops items untouched for over six months rather than ranking them", () => {
    const result = buildNextUp({
      sessions: [],
      todos: [todo({ ageDays: 4302, key: "old#1" }), todo({ ageDays: 2, key: "new#1" })],
      todosAvailable: true,
      todosReason: null,
      now: NOW,
    });
    expect(result.items.map((i) => i.key)).toEqual(["new#1"]);
  });

  it("ranks PRs above issues", () => {
    const result = buildNextUp({
      sessions: [],
      todos: [
        todo({ kind: "issue", key: "i#1", ageDays: 0 }),
        todo({ kind: "pr", key: "p#1", ageDays: 30 }),
      ],
      todosAvailable: true,
      todosReason: null,
      now: NOW,
    });
    expect(result.items.map((i) => i.kind)).toEqual(["review", "issue"]);
  });

  it("marks the ranking partial when GitHub could not be read", () => {
    // An empty list whose input failed must not read as "you're all clear".
    const result = buildNextUp({
      sessions: [],
      todos: [],
      todosAvailable: false,
      todosReason: "gh not authenticated",
      now: NOW,
    });
    expect(result.partial).toBe(true);
    expect(result.reason).toBe("gh not authenticated");
    expect(result.items).toHaveLength(0);
  });

  it("is not partial when everything was read and there is simply nothing", () => {
    const result = buildNextUp({
      sessions: [],
      todos: [],
      todosAvailable: true,
      todosReason: null,
      now: NOW,
    });
    expect(result.partial).toBe(false);
    expect(result.reason).toBeNull();
  });

  it("respects the limit", () => {
    const result = buildNextUp({
      sessions: [session()],
      todos: [todo({ key: "a" }), todo({ key: "b" }), todo({ key: "c" })],
      todosAvailable: true,
      todosReason: null,
      now: NOW,
      limit: 2,
    });
    expect(result.items).toHaveLength(2);
  });

  it("tolerates a null age rather than dropping the item", () => {
    const result = buildNextUp({
      sessions: [],
      todos: [todo({ ageDays: null })],
      todosAvailable: true,
      todosReason: null,
      now: NOW,
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].why).not.toContain("null");
  });
});

describe("session-read failures make the ranking partial", () => {
  it("is partial when the logs could not be read, even with GitHub healthy", () => {
    // The bad sentence this prevents: "Nothing queued up. No recent session
    // to resume" — asserting an absence of work from a read that never ran.
    const result = buildNextUp({
      sessions: [],
      todos: [],
      todosAvailable: true,
      todosReason: null,
      sessionsReason: "claude logs could not be read",
      now: NOW,
    });
    expect(result.partial).toBe(true);
    expect(result.reason).toContain("claude");
  });

  it("reports both failures rather than only the first", () => {
    const result = buildNextUp({
      sessions: [],
      todos: [],
      todosAvailable: false,
      todosReason: "gh not authenticated",
      sessionsReason: "codex logs were read only partially",
      now: NOW,
    });
    expect(result.reason).toContain("gh not authenticated");
    expect(result.reason).toContain("codex");
  });

  it("stays complete when sessions were read cleanly", () => {
    const result = buildNextUp({
      sessions: [session()],
      todos: [],
      todosAvailable: true,
      todosReason: null,
      sessionsReason: null,
      now: NOW,
    });
    expect(result.partial).toBe(false);
    expect(result.reason).toBeNull();
  });
});
