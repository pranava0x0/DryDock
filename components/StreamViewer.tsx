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
}: StreamViewerProps) {
  const [lines, setLines] = useState<Line[]>([]);
  const [closed, setClosed] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
        // `data.type` is narrowed to "stdout" | "stderr" here since we
        // returned early on "exit" above. The cast keeps TS happy without
        // forcing a redundant switch.
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
    </aside>
  );
}
