import { promises as fs } from "node:fs";
import { join, basename, sep } from "node:path";
import { homedir } from "node:os";

/**
 * "What was I in the middle of?" — the most recent working sessions across
 * Claude Code, the Codex CLI, and Google Antigravity, in one list.
 *
 * ── Why this is not the usage scanners ──────────────────────────────────
 * `claude-scan` / `codex-scan` / `antigravity-scan` answer *how much* —
 * they aggregate every log on disk into per-day token rows, and they are
 * expensive (888 MB of Claude JSONL alone on this machine). This answers
 * *what*, for the last couple of weeks only, and it must be cheap enough
 * to sit on the dashboard's first paint.
 *
 * Two things make it cheap:
 *
 *  1. **mtime pre-filter.** Only files touched inside the window are
 *     opened at all — 107 of 1,014 Claude files, on a 7-day window.
 *  2. **Head + tail, never the whole file.** A session's identity (cwd,
 *     branch, start) is in the first few records and its label
 *     (`custom-title` / `ai-title` / `last-prompt`) is in the last ~5% —
 *     measured across the newest logs, the deepest was 78% in. So we read
 *     a 32 KB head and a 512 KB tail and skip the middle, which turns a
 *     163 MB read into a bounded worst case and usually far less.
 *
 * ── Honesty rules this file inherits ────────────────────────────────────
 * Every tool reports its own `health`. A tool whose logs could not be read
 * must never render as "no sessions" — that is the repo's standing
 * looks-like-success trap, and here it would quietly tell you that you
 * haven't used Codex in a month when really the directory moved. So
 * `lastActiveAt` is derived from a stat-only walk over *all* files, not
 * just in-window ones, which is why the UI can say "last used 27d ago"
 * for a tool with zero sessions in the window.
 *
 * Privacy: the user's own prompt text is read, because that is the entire
 * point of the feature ("what did I leave off on"). It stays local — it is
 * returned to the local dashboard and never persisted or sent anywhere.
 */

import type {
  RecentSession,
  RecentSessionsResult,
  SessionTool,
  ToolHealth,
  ToolStatus,
} from "./recent-sessions.types";

// Re-exported so server-side callers have one import site, while client
// components import the same names from `./recent-sessions.types` and stay
// clear of the `node:fs` dependency below.
export type {
  RecentSession,
  RecentSessionsResult,
  SessionTool,
  ToolHealth,
  ToolStatus,
};

/** Default lookback. Two weeks survives a holiday without going stale. */
export const RECENT_WINDOW_DAYS = 14;

/**
 * Per-tool ceiling on files opened, newest first. A pathological week
 * (hundreds of sessions) must not turn the dashboard's first paint into a
 * multi-second read; `skipped` reports what this dropped so the cap is
 * visible rather than silent.
 */
const MAX_FILES_PER_TOOL = 40;

const HEAD_BYTES = 32 * 1024;
const TAIL_BYTES = 512 * 1024;

interface FileEntry {
  path: string;
  mtimeMs: number;
  size: number;
}

/**
 * Read at most `head` bytes from the front and `tail` bytes from the back.
 * Returns them separately: a caller must not treat the join as contiguous
 * text, because for a large file it is two disjoint slices.
 */
interface Slices {
  head: string;
  tail: string;
  /**
   * True when head and tail are the same string because the file fit in
   * one read. Callers must then scan it once, not twice.
   */
  whole: boolean;
}

async function readHeadTail(
  path: string,
  size: number,
  head = HEAD_BYTES,
  tail = TAIL_BYTES,
): Promise<Slices> {
  const handle = await fs.open(path, "r");
  try {
    if (size <= head + tail) {
      const buf = Buffer.alloc(size);
      await handle.read(buf, 0, size, 0);
      const text = buf.toString("utf8");
      return { head: text, tail: text, whole: true };
    }
    const headBuf = Buffer.alloc(head);
    await handle.read(headBuf, 0, head, 0);
    const tailBuf = Buffer.alloc(tail);
    await handle.read(tailBuf, 0, tail, size - tail);
    return {
      head: headBuf.toString("utf8"),
      tail: tailBuf.toString("utf8"),
      whole: false,
    };
  } finally {
    await handle.close();
  }
}

/**
 * Whole JSONL lines only.
 *
 * Which edge is a fragment depends on which slice this is, and getting it
 * wrong silently loses a real record rather than erroring:
 *
 *  - A **truncated head** ends mid-line → drop the last.
 *  - A **tail of a larger file** starts mid-line → drop the first.
 *  - A file read **in full** has no fragment at either end → drop neither.
 *
 * The last case is the one that bites: unconditionally dropping the final
 * line discarded the newest record of every small log, which is exactly
 * where `custom-title` and the final `user_message` live.
 */
function completeLines(
  chunk: string,
  { dropFirst = false, dropLast = false } = {},
): string[] {
  const lines = chunk.split("\n");
  if (dropFirst) lines.shift();
  if (dropLast) lines.pop();
  return lines.filter((l) => l.length > 0);
}

function parseOrNull(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Collapse a worktree path to the project it belongs to.
 *
 * DryDock runs agents inside `<project>/.claude/worktrees/<branch>`, so a
 * session's raw cwd reads as the worktree slug — "website-session-kickoff-
 * 0a396b" instead of "DryDock". That is noise in a list whose whole job is
 * to say which project you were in.
 */
export function collapseWorktreePath(cwd: string): string {
  const marker = `${sep}.claude${sep}worktrees${sep}`;
  const at = cwd.indexOf(marker);
  return at === -1 ? cwd : cwd.slice(0, at);
}

/** Strip XML-ish ambient blocks the CLIs inject into the user turn. */
function stripInjectedBlocks(text: string): string {
  return text
    .replace(/<([a-zA-Z][\w-]*)(\s[^>]*)?>[\s\S]*?<\/\1>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/^#\s*Files mentioned by the user:[\s\S]*$/m, " ");
}

/**
 * A one-line, human-readable excerpt of a prompt, or null when what's left
 * is machinery rather than something the user typed.
 */
export function cleanPrompt(raw: string, maxChars = 180): string | null {
  const stripped = stripInjectedBlocks(raw)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (stripped.length < 3) return null;
  return stripped.length > maxChars
    ? `${stripped.slice(0, maxChars - 1).trimEnd()}…`
    : stripped;
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Recursive stat-only walk. Cheap: no file contents are read. */
async function walkFiles(
  root: string,
  accept: (path: string) => boolean,
  out: FileEntry[] = [],
): Promise<FileEntry[]> {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(path, accept, out);
    } else if (accept(path)) {
      try {
        const st = await fs.stat(path);
        out.push({ path, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        // Vanished between readdir and stat — skip it.
      }
    }
  }
  return out;
}

interface ToolScan {
  sessions: RecentSession[];
  status: ToolStatus;
}

function emptyStatus(
  tool: SessionTool,
  health: ToolHealth,
  reason: string | null = null,
): ToolStatus {
  return { tool, health, lastActiveAt: null, filesRead: 0, skipped: 0, reason };
}

/**
 * Shared shape for all three readers: walk, pre-filter by mtime, cap, then
 * hand each survivor to a per-tool parser.
 */
async function scanTool(
  tool: SessionTool,
  root: string,
  accept: (path: string) => boolean,
  since: number,
  parse: (file: FileEntry) => Promise<RecentSession | null>,
): Promise<ToolScan> {
  try {
    await fs.access(root);
  } catch {
    return { sessions: [], status: emptyStatus(tool, "missing") };
  }

  let all: FileEntry[];
  try {
    all = await walkFiles(root, accept);
  } catch (err) {
    return {
      sessions: [],
      status: emptyStatus(tool, "error", (err as Error).message),
    };
  }
  if (all.length === 0) {
    return { sessions: [], status: emptyStatus(tool, "missing") };
  }

  // Of any age — this is what lets the UI say "last used 27d ago".
  const lastActiveAt = new Date(
    Math.max(...all.map((f) => f.mtimeMs)),
  ).toISOString();

  const inWindow = all
    .filter((f) => f.mtimeMs >= since && f.size > 0)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  const chosen = inWindow.slice(0, MAX_FILES_PER_TOOL);

  const sessions: RecentSession[] = [];
  let filesRead = 0;
  for (const file of chosen) {
    filesRead += 1;
    try {
      const session = await parse(file);
      if (session) sessions.push(session);
    } catch {
      // One unreadable log must not blank the other 39.
    }
  }

  return {
    sessions,
    status: {
      tool,
      health: "ok",
      lastActiveAt,
      filesRead,
      skipped: inWindow.length - chosen.length,
      reason: null,
    },
  };
}

/* ─────────────────────────── Claude Code ─────────────────────────── */

/**
 * The text of a genuine user turn, or null for anything the harness
 * injected on the user's behalf.
 *
 * Claude Code writes several things as `type: "user"` that the user never
 * typed: tool results, queued-command echoes, and `isMeta` records
 * carrying reminders and hook output. Showing one of those as "where you
 * left off" would be worse than showing nothing — it reads as a real
 * instruction you don't remember giving.
 */
function claudeUserText(rec: Record<string, unknown>): string | null {
  if (rec.type !== "user") return null;
  if (rec.isMeta === true) return null;
  const message = rec.message as Record<string, unknown> | undefined;
  if (!message) return null;

  const content = message.content;
  if (typeof content === "string") return cleanPrompt(content);
  if (!Array.isArray(content)) return null;

  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;
    // tool_result blocks are the transcript talking to itself.
    if (b.type !== "text" || typeof b.text !== "string") continue;
    parts.push(b.text);
  }
  return parts.length === 0 ? null : cleanPrompt(parts.join(" "));
}

/**
 * `~/.claude/projects/<encoded>/<sessionId>.jsonl`, plus subagent
 * transcripts nested under `<sessionId>/subagents/`.
 *
 * The subagent logs are deliberately excluded: they are not sessions you
 * left off in, they are children of one, and including them would list the
 * same piece of work a dozen times. (Note this is the mirror image of the
 * usage-ledger bug — there, *not* walking into `subagents/` undercounted
 * tokens by 46%. Different question, opposite answer.)
 */
async function scanClaude(root: string, since: number): Promise<ToolScan> {
  return scanTool(
    "claude",
    root,
    (p) => p.endsWith(".jsonl") && !p.includes(`${sep}subagents${sep}`),
    since,
    async (file) => {
      const { head, tail, whole } = await readHeadTail(file.path, file.size);

      let cwd: string | null = null;
      let branch: string | null = null;
      let startedAt: string | null = null;
      // Later records win: a session renamed mid-flight should show the
      // name it ended with.
      let customTitle: string | null = null;
      let aiTitle: string | null = null;
      let lastPromptRecord: string | null = null;
      let latestUserText: string | null = null;
      let endedAt: string | null = null;

      const consume = (line: string) => {
        const rec = parseOrNull(line);
        if (!rec) return;
        const ts = isoOrNull(rec.timestamp);
        if (ts) {
          if (startedAt === null || ts < startedAt) startedAt = ts;
          if (endedAt === null || ts > endedAt) endedAt = ts;
        }
        // cwd/gitBranch ride along on ordinary turn records, so they can
        // sit past the 32 KB head on a session that opens with a long
        // summary or file-history block. Take them from wherever they
        // first appear rather than assuming the head has them.
        if (cwd === null && typeof rec.cwd === "string" && rec.cwd) cwd = rec.cwd;
        if (branch === null && typeof rec.gitBranch === "string" && rec.gitBranch) {
          branch = rec.gitBranch;
        }
        if (typeof rec.customTitle === "string" && rec.customTitle.trim()) {
          customTitle = rec.customTitle.trim();
        }
        if (typeof rec.aiTitle === "string" && rec.aiTitle.trim()) {
          aiTitle = rec.aiTitle.trim();
        }
        if (typeof rec.lastPrompt === "string") {
          lastPromptRecord = cleanPrompt(rec.lastPrompt) ?? lastPromptRecord;
        }
        const userText = claudeUserText(rec);
        if (userText) latestUserText = userText;
      };

      // When the file fit in one read, `head` IS the file — scan it once
      // with both edges intact. Otherwise the head is a truncated prefix
      // and the tail a suffix, each missing one fragment line.
      for (const line of completeLines(head, { dropLast: !whole })) consume(line);
      if (!whole) {
        for (const line of completeLines(tail, { dropFirst: true })) consume(line);
      }

      // A `last-prompt` record is authoritative when present, but plenty
      // of sessions never write one — fall back to the newest real user
      // turn rather than leaving the row's most useful line blank.
      const lastPrompt = lastPromptRecord ?? latestUserText;
      const project = cwd ? basename(collapseWorktreePath(cwd)) : null;
      const title =
        customTitle ?? aiTitle ?? lastPrompt ?? project ?? "Untitled session";
      return {
        tool: "claude",
        id: basename(file.path, ".jsonl"),
        title,
        lastPrompt,
        cwd: cwd ? collapseWorktreePath(cwd) : null,
        project,
        branch,
        startedAt,
        // mtime is the honest end: the last write to the log.
        endedAt: endedAt ?? new Date(file.mtimeMs).toISOString(),
      };
    },
  );
}

/* ───────────────────────────── Codex CLI ─────────────────────────── */

async function parseCodexRollout(file: FileEntry): Promise<RecentSession | null> {
  const { head, tail, whole } = await readHeadTail(file.path, file.size);

  let id: string | null = null;
  let cwd: string | null = null;
  let startedAt: string | null = null;
  for (const line of completeLines(head, { dropLast: !whole })) {
    if (!line.includes("session_meta") && !line.includes("turn_context")) continue;
    const rec = parseOrNull(line);
    const payload = rec?.payload as Record<string, unknown> | undefined;
    if (!payload) continue;
    if (id === null && typeof payload.session_id === "string") id = payload.session_id;
    if (cwd === null && typeof payload.cwd === "string") cwd = payload.cwd;
    if (startedAt === null) startedAt = isoOrNull(rec?.timestamp);
    if (id && cwd && startedAt) break;
  }

  // The newest legible user turn is the "where you left off" line, and the
  // first is the best topic label. Scan forward keeping both.
  let lastPrompt: string | null = null;
  let firstPrompt: string | null = null;
  let endedAt: string | null = null;
  for (const line of completeLines(tail, { dropFirst: !whole })) {
    const rec = parseOrNull(line);
    if (!rec) continue;
    const ts = isoOrNull(rec.timestamp);
    if (ts && (endedAt === null || ts > endedAt)) endedAt = ts;
    const payload = rec.payload as Record<string, unknown> | undefined;
    if (!payload || payload.type !== "user_message") continue;
    if (typeof payload.message !== "string") continue;
    const cleaned = cleanPrompt(payload.message);
    if (cleaned) {
      lastPrompt = cleaned;
      firstPrompt ??= cleaned;
    }
  }

  const project = cwd ? basename(collapseWorktreePath(cwd)) : null;
  const title = firstPrompt ?? lastPrompt ?? project ?? "Codex session";
  return {
    tool: "codex",
    id: id ?? basename(file.path, ".jsonl"),
    title: cleanPrompt(title, 90) ?? title,
    lastPrompt,
    cwd: cwd ? collapseWorktreePath(cwd) : null,
    project,
    branch: null,
    startedAt,
    endedAt: endedAt ?? new Date(file.mtimeMs).toISOString(),
  };
}

/**
 * Codex writes one rollout JSONL per session under `~/.codex/sessions`
 * (date-sharded) and flattens older ones into `~/.codex/archived_sessions`.
 * The archive is a sibling directory, not a child, so it is walked
 * separately and folded in — the usage reader learned the same lesson.
 */
async function scanCodex(
  root: string,
  archiveRoot: string,
  since: number,
): Promise<ToolScan> {
  const [live, archived] = await Promise.all([
    scanTool("codex", root, (p) => p.endsWith(".jsonl"), since, parseCodexRollout),
    scanTool(
      "codex",
      archiveRoot,
      (p) => p.endsWith(".jsonl"),
      since,
      parseCodexRollout,
    ),
  ]);

  // Only genuinely missing when NEITHER store is present.
  if (live.status.health === "missing" && archived.status.health === "missing") {
    return live;
  }

  const lastActiveAt =
    [live.status.lastActiveAt, archived.status.lastActiveAt]
      .filter((v): v is string => v !== null)
      .sort()
      .pop() ?? null;

  return {
    sessions: [...live.sessions, ...archived.sessions],
    status: {
      tool: "codex",
      health:
        live.status.health === "error" || archived.status.health === "error"
          ? "error"
          : "ok",
      lastActiveAt,
      filesRead: live.status.filesRead + archived.status.filesRead,
      skipped: live.status.skipped + archived.status.skipped,
      reason: live.status.reason ?? archived.status.reason,
    },
  };
}

/* ─────────────────────────── Antigravity ─────────────────────────── */

/**
 * `~/.gemini/antigravity/brain/<conv>/.system_generated/logs/transcript.jsonl`.
 * Steps are typed; `USER_INPUT` wraps what you typed in `<USER_REQUEST>`.
 *
 * There is no cwd and no branch anywhere in this format, so both stay null
 * rather than being guessed from the request text.
 */
async function scanAntigravity(root: string, since: number): Promise<ToolScan> {
  return scanTool(
    "antigravity",
    root,
    // `transcript_full` is a superset written alongside `transcript`;
    // reading both would list every conversation twice.
    (p) => p.endsWith(`${sep}transcript.jsonl`),
    since,
    async (file) => {
      const { head, tail, whole } = await readHeadTail(file.path, file.size);

      const requests: string[] = [];
      let startedAt: string | null = null;
      let endedAt: string | null = null;
      const collect = (chunk: string, edges: { dropFirst?: boolean; dropLast?: boolean }) => {
        for (const line of completeLines(chunk, edges)) {
          const rec = parseOrNull(line);
          if (!rec) continue;
          const ts = isoOrNull(rec.created_at);
          if (ts) {
            if (startedAt === null || ts < startedAt) startedAt = ts;
            if (endedAt === null || ts > endedAt) endedAt = ts;
          }
          if (rec.type !== "USER_INPUT" || typeof rec.content !== "string") continue;
          const match = rec.content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
          const cleaned = cleanPrompt(match ? match[1] : rec.content);
          if (cleaned) requests.push(cleaned);
        }
      };
      collect(head, { dropLast: !whole });
      if (!whole) collect(tail, { dropFirst: true });

      // `<conv>/.system_generated/logs/transcript.jsonl` → `<conv>`
      const id = basename(join(file.path, "..", "..", ".."));
      const first = requests[0] ?? null;
      const last = requests[requests.length - 1] ?? null;
      return {
        tool: "antigravity",
        id,
        title:
          (first ? cleanPrompt(first, 90) : null) ?? "Antigravity conversation",
        lastPrompt: last,
        cwd: null,
        project: null,
        branch: null,
        startedAt,
        endedAt: endedAt ?? new Date(file.mtimeMs).toISOString(),
      };
    },
  );
}

/* ───────────────────────────── Entry point ───────────────────────── */

export interface RecentSessionsOptions {
  windowDays?: number;
  limit?: number;
  /**
   * Roots are explicit and absolute rather than derived, so a test can
   * point every one of them at a fixture. A default that resolves to the
   * developer's own `~/.claude` is how a test suite ends up reading a
   * personal transcript archive.
   */
  claudeRoot?: string;
  codexRoot?: string;
  codexArchiveRoot?: string;
  antigravityRoot?: string;
  now?: Date;
}

export async function readRecentSessions(
  options: RecentSessionsOptions = {},
): Promise<RecentSessionsResult> {
  const windowDays = options.windowDays ?? RECENT_WINDOW_DAYS;
  const now = options.now ?? new Date();
  const since = now.getTime() - windowDays * 86_400_000;
  const limit = options.limit ?? 8;

  const home = homedir();
  const [claude, codex, antigravity] = await Promise.all([
    scanClaude(options.claudeRoot ?? join(home, ".claude", "projects"), since),
    scanCodex(
      options.codexRoot ?? join(home, ".codex", "sessions"),
      options.codexArchiveRoot ?? join(home, ".codex", "archived_sessions"),
      since,
    ),
    scanAntigravity(
      options.antigravityRoot ?? join(home, ".gemini", "antigravity", "brain"),
      since,
    ),
  ]);

  // Scheduled work (a nightly sweep, a daily digest) writes a
  // near-identical session every day, so an un-deduped list is mostly the
  // same three cron jobs repeated. Collapse repeats of the same topic in
  // the same project and keep the newest — the older runs are still in
  // Analytics, they just don't belong on a "where was I" list.
  const seen = new Set<string>();
  const sessions: RecentSession[] = [];
  for (const session of [
    ...claude.sessions,
    ...codex.sessions,
    ...antigravity.sessions,
  ].sort((a, b) => b.endedAt.localeCompare(a.endedAt))) {
    const key = `${session.tool}|${session.project ?? ""}|${session.title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sessions.push(session);
    if (sessions.length >= limit) break;
  }

  return {
    sessions,
    tools: [claude.status, codex.status, antigravity.status],
    windowDays,
  };
}
