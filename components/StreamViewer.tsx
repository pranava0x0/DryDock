"use client";

import { useEffect, useRef, useState } from "react";
import type { AgentEvent } from "@/lib/providers";

export interface StreamViewerProps {
  taskId: string;
  /**
   * Increment this to force the viewer to re-subscribe. Used after the
   * caller starts a fresh run — we want to drop the previous transcript and
   * connect to the new one.
   */
  subscriptionKey: number;
  onClose: () => void;
  /**
   * Called after a follow-up turn is dispatched, with the new run id, so the
   * parent can flip the task back to "running" and re-subscribe the viewer.
   */
  onFollowup?: (runId: string) => void;
}

interface Line {
  kind: "stdout" | "stderr" | "system";
  text: string;
}

/**
 * Bottom sheet (mobile) / right-side panel (desktop) that consumes the SSE
 * stream and renders a terminal-style live transcript.
 *
 * Implementation notes:
 *   - We use the browser's EventSource which auto-reconnects, but since we
 *     also want to abort on unmount we wrap it in a useEffect cleanup.
 *   - Auto-scroll only sticks when the user is already at the bottom; if
 *     they scroll up to inspect output we leave them alone (a common
 *     terminal-UX expectation).
 */
export function StreamViewer({
  taskId,
  subscriptionKey,
  onClose,
  onFollowup,
}: StreamViewerProps) {
  const [lines, setLines] = useState<Line[]>([]);
  const [closed, setClosed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [followup, setFollowup] = useState("");
  const [sending, setSending] = useState(false);
  const [followupNote, setFollowupNote] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Tracks whether the user is currently pinned to the bottom of the scroll
  // view. Updated on each scroll event; consulted on each new line.
  const stickyBottomRef = useRef(true);

  useEffect(() => {
    setLines([]);
    setClosed(false);
    setError(null);
    const source = new EventSource(`/api/tasks/${taskId}/stream`);

    source.addEventListener("open", () => {
      setLines((prev) => [
        ...prev,
        { kind: "system", text: "[connected — waiting for output]" },
      ]);
    });

    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as AgentEvent;
        if (data.type === "exit") {
          setLines((prev) => [
            ...prev,
            {
              kind: "system",
              text: `[exit code ${data.code ?? "?"}]`,
            },
          ]);
          setClosed(true);
          source.close();
          return;
        }
        // `session` events are internal plumbing the dispatcher consumes —
        // they never cross the SSE boundary, but the union includes them, so
        // skip defensively rather than render an empty line.
        if (data.type === "session") return;
        // `data.type` is narrowed to "stdout" | "stderr" | "usage" here since
        // we returned early on "exit"/"session". All of those carry `data`.
        const kind: Line["kind"] = data.type === "stderr" ? "stderr" : "stdout";
        setLines((prev) => [...prev, { kind, text: data.data }]);
      } catch (err) {
        setError(`failed to parse event: ${(err as Error).message}`);
      }
    };

    source.onerror = () => {
      // EventSource keeps trying to reconnect on transient errors; we surface
      // a friendly message rather than spamming the user.
      setError("stream interrupted");
    };

    return () => {
      source.close();
    };
  }, [taskId, subscriptionKey]);

  useEffect(() => {
    if (stickyBottomRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines]);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    // 32px slop so we stick to bottom even with a tiny scroll wobble.
    stickyBottomRef.current =
      el.scrollHeight - el.clientHeight - el.scrollTop < 32;
  };

  const sendFollowup = async () => {
    const prompt = followup.trim();
    if (!prompt || sending) return;
    setSending(true);
    setFollowupNote(null);
    try {
      const res = await fetch(`/api/tasks/${taskId}/followup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFollowupNote(data.error ?? "Couldn't send follow-up");
        return;
      }
      setFollowup("");
      if (data.queued) {
        setFollowupNote(`Queued — #${data.position} in line`);
        return;
      }
      // resumed:false means there was no session to resume, so we started a
      // fresh run carrying the feedback — say so rather than implying a
      // seamless continuation.
      if (data.resumed === false) {
        setFollowupNote("No session to resume — started a fresh run.");
      }
      if (data.runId && onFollowup) onFollowup(data.runId);
    } catch (err) {
      setFollowupNote((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <aside className="fixed inset-x-0 bottom-0 z-30 flex max-h-[80vh] flex-col rounded-t-2xl border border-kraken-boundless bg-kraken-deep shadow-2xl sm:inset-x-auto sm:right-4 sm:top-20 sm:w-[420px] sm:rounded-2xl">
      <header className="flex items-center justify-between border-b border-kraken-boundless px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold text-zinc-50">Agent output</h3>
          <p className="text-xs text-zinc-500">
            {closed ? "finished" : "live"}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="min-h-[44px] min-w-[44px] rounded-md text-zinc-400 transition hover:bg-kraken-boundless/40 hover:text-zinc-200"
          aria-label="Close output panel"
        >
          ✕
        </button>
      </header>
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="stream-output flex-1 overflow-y-auto bg-black px-3 py-3 font-mono text-xs text-zinc-200"
      >
        {lines.length === 0 ? (
          <p className="text-zinc-600">[no output yet]</p>
        ) : (
          lines.map((line, i) => (
            <div
              key={i}
              className={
                line.kind === "stderr"
                  ? "text-red-300"
                  : line.kind === "system"
                    ? "text-zinc-500"
                    : "text-zinc-200"
              }
            >
              {line.text || " "}
            </div>
          ))
        )}
      </div>
      {error ? (
        <p
          className="border-t border-red-500/30 bg-red-500/10 px-4 py-2 text-xs text-red-300"
          role="alert"
        >
          {error}
        </p>
      ) : null}
      {closed ? (
        <div className="border-t border-kraken-boundless p-3">
          <label htmlFor="followup" className="sr-only">
            Follow-up instruction
          </label>
          <textarea
            id="followup"
            value={followup}
            onChange={(e) => setFollowup(e.target.value)}
            rows={2}
            placeholder="Follow up — e.g. 'now fix the failing tests'"
            className="block w-full resize-none rounded-md border border-kraken-boundless bg-kraken-deep p-2 text-sm text-zinc-50 placeholder-zinc-600 focus:border-kraken-ice focus:outline-none"
          />
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void sendFollowup()}
              disabled={sending || followup.trim().length === 0}
              className="inline-flex min-h-[44px] items-center rounded-md bg-kraken-ice px-4 text-sm font-semibold text-kraken-deep transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {sending ? "Sending…" : "Follow up"}
            </button>
            {followupNote ? (
              <span className="text-xs text-kraken-shadow" role="status">
                {followupNote}
              </span>
            ) : (
              <span className="text-xs text-zinc-600">
                Resumes the agent&apos;s session with full context.
              </span>
            )}
          </div>
        </div>
      ) : null}
    </aside>
  );
}
