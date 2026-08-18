"use client";

import {
  TOOL_LABELS,
  type RecentSession,
  type RecentSessionsResult,
  type SessionTool,
  type ToolStatus,
} from "@/lib/connectors/recent-sessions.types";
import { Disclosure } from "@/components/Disclosure";

/**
 * "Where you left off" — the newest sessions across Claude Code, Codex and
 * Antigravity in one list.
 *
 * ── The per-tool footer is the point ────────────────────────────────────
 * Two of these three tools usually have nothing in the window, and an
 * unlabelled list would silently imply you only ever use Claude. So every
 * tool reports itself in the footer: how many logs were read, or when it
 * was last used if the answer is "none this fortnight", or that it
 * couldn't be read at all. A tool with zero sessions and a tool whose
 * directory has moved must not look identical.
 */

const TOOL_BADGE: Record<SessionTool, string> = {
  claude: "bg-kraken-ice/15 text-kraken-ice",
  codex: "bg-violet-300/15 text-violet-300",
  antigravity: "bg-sky-300/15 text-sky-300",
};

/** Coarse relative time. Precision beyond "3d ago" is noise here. */
function ago(iso: string, now: number): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "unknown";
  const mins = Math.round((now - ms) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/**
 * Sessions shown before the list collapses.
 *
 * Four covers "today and yesterday" on a normal week. The full read
 * returns eight, and eight rows of three lines each is most of a phone
 * screen for a panel that answers a question you usually settle in the
 * first row.
 */
const VISIBLE_SESSIONS = 4;

export function RecentSessions({ recent }: { recent: RecentSessionsResult }) {
  const now = Date.now();
  const { sessions, tools, windowDays } = recent;
  const visible = sessions.slice(0, VISIBLE_SESSIONS);
  const rest = sessions.slice(VISIBLE_SESSIONS);

  return (
    <section className="mt-6">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium text-zinc-200">Where you left off</h2>
        <span className="text-xs text-kraken-shadow">last {windowDays} days</span>
      </div>

      {sessions.length === 0 ? (
        <p className="mt-1 text-xs text-kraken-shadow">
          No sessions in the window.
        </p>
      ) : (
        <ul className="mt-2 divide-y divide-kraken-boundless/60 rounded-lg border border-kraken-boundless">
          {visible.map((session, i) => (
            <li
              key={`${session.tool}:${session.id}`}
              className="dd-rise"
              style={{ ["--dd-delay" as string]: `${Math.min(i, 6) * 35}ms` }}
            >
              <SessionRow session={session} now={now} />
            </li>
          ))}
        </ul>
      )}

      {/* Older sessions and the per-tool health report, collapsed together.
          The summary line IS the health report in short form — so an idle
          or broken tool is still visible without opening anything, which is
          the whole point of reporting per-tool status in the first place. */}
      <div className="mt-2">
        <Disclosure
          title={rest.length > 0 ? `${rest.length} older` : "Session sources"}
          summary={toolsSummary(tools, now)}
        >
          {rest.length > 0 ? (
            <ul className="divide-y divide-kraken-boundless/60">
              {rest.map((session) => (
                <li key={`${session.tool}:${session.id}`}>
                  <SessionRow session={session} now={now} />
                </li>
              ))}
            </ul>
          ) : null}
          <ul className={rest.length > 0 ? "mt-3 space-y-1" : "space-y-1"}>
            {tools.map((tool) => (
              <li key={tool.tool} className="text-xs text-kraken-shadow">
                <ToolFootnote status={tool} now={now} />
              </li>
            ))}
          </ul>
        </Disclosure>
      </div>
    </section>
  );
}

/**
 * One line covering all three tools, for the collapsed row.
 *
 * Anything unhealthy or idle is named explicitly; the healthy ones
 * collapse to a count. A silent tool is the failure mode this panel
 * exists to prevent, so it must survive the summarising.
 */
function toolsSummary(tools: ToolStatus[], now: number): string {
  const notable = tools.filter((t) => t.health !== "ok" || t.filesRead === 0);
  const okCount = tools.length - notable.length;
  const parts = notable.map((t) => {
    const name = TOOL_LABELS[t.tool];
    if (t.health === "error") return `${name} unreadable`;
    if (t.health === "missing") return `${name} not installed`;
    return t.lastActiveAt
      ? `${name} idle ${ago(t.lastActiveAt, now)}`
      : `${name} idle`;
  });
  if (okCount > 0) parts.unshift(`${okCount} active`);
  return parts.join(" · ");
}

function SessionRow({ session, now }: { session: RecentSession; now: number }) {
  return (
    <div className="px-3 py-2">
      <div className="flex items-center gap-2">
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${TOOL_BADGE[session.tool]}`}
        >
          {TOOL_LABELS[session.tool]}
        </span>
        <span className="truncate text-xs text-kraken-shadow">
          {session.project ?? "unknown project"}
          {session.branch ? ` · ${session.branch}` : ""}
        </span>
        <span className="ml-auto shrink-0 text-xs text-kraken-shadow">
          {ago(session.endedAt, now)}
        </span>
      </div>
      <p className="mt-1 truncate text-sm text-zinc-100">{session.title}</p>
      {session.lastPrompt && session.lastPrompt !== session.title ? (
        <p className="mt-0.5 line-clamp-2 text-xs text-kraken-shadow">
          last: {session.lastPrompt}
        </p>
      ) : null}
    </div>
  );
}

function ToolFootnote({ status, now }: { status: ToolStatus; now: number }) {
  const name = TOOL_LABELS[status.tool];

  if (status.health === "error") {
    return (
      <span className="text-kraken-alert">
        {name}: could not read logs{status.reason ? ` — ${status.reason}` : ""}
      </span>
    );
  }
  if (status.health === "missing") {
    return <span>{name}: no logs on this machine</span>;
  }
  if (status.filesRead === 0) {
    // Zero in the window is not zero ever — say when it was last used, so
    // an idle tool doesn't read as an uninstalled one.
    return (
      <span>
        {name}: nothing in window
        {status.lastActiveAt ? ` · last used ${ago(status.lastActiveAt, now)}` : ""}
      </span>
    );
  }
  return (
    <span>
      {name}: {status.filesRead} log{status.filesRead === 1 ? "" : "s"} read
      {/* A cap that was hit is a floor, not a total. */}
      {status.skipped > 0 ? ` · ${status.skipped} more not opened` : ""}
      {/* A read that partly failed is not a complete read. `health` is
          still "ok" because real sessions came back, so the reason is the
          only thing distinguishing this from a whole answer. */}
      {status.reason ? (
        <span className="text-amber-300"> · {status.reason}</span>
      ) : null}
    </span>
  );
}
