import { promises as fs } from "node:fs";

/**
 * Shared mtime pre-filter for the provider usage readers.
 *
 * Each reader aggregates per-turn token/activity counts into rolling
 * windows (5h / weekly / monthly). A session log's mtime is the time of its
 * last write, which is >= the timestamp of its last turn. So if a file's
 * mtime is older than the widest (earliest) window cutoff, *every* turn in
 * it predates the window and it can be skipped without reading a byte.
 *
 * This is what keeps the Claude card from streaming ~700MB of month-old
 * session logs on every cache miss (the cold read was ~13s before this).
 * It's provably lossless: a skipped file cannot contribute to any window.
 */

/**
 * Slack between a turn's ISO timestamp and the file's mtime. Generous on
 * purpose — the cost of keeping a few boundary files is one extra read;
 * the cost of wrongly skipping one is a silently-low number. 12h dwarfs any
 * real filesystem/clock skew while still cutting the vast bulk of old logs.
 */
export const MTIME_SAFETY_MARGIN_MS = 12 * 60 * 60 * 1000;

/** The earliest of the given window cutoffs — the one that admits the most files. */
export function widestCutoff(...cutoffs: Date[]): Date {
  return new Date(Math.min(...cutoffs.map((c) => c.getTime())));
}

type StatFn = (path: string) => Promise<{ mtimeMs: number }>;

/**
 * True if `filePath` may contain a turn at or after `cutoff` — i.e. it was
 * modified recently enough to be worth reading. A file we can't stat is
 * treated as "worth reading" (fail open: never silently drop data because
 * of a stat hiccup; the reader's own error handling covers a bad read).
 */
export async function mayContainRecentTurns(
  filePath: string,
  cutoff: Date,
  statFn: StatFn = fs.stat,
): Promise<boolean> {
  try {
    const st = await statFn(filePath);
    return st.mtimeMs >= cutoff.getTime() - MTIME_SAFETY_MARGIN_MS;
  } catch {
    return true;
  }
}
