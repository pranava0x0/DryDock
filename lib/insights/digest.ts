import { inboxCount, listBacklog } from "../db/backlog";
import { listTasks } from "../db/tasks";
import { usageBy, usageTotals } from "../db/usage";
import { getSubscription } from "../db/subscriptions";
import { quotaStatus } from "../connectors/quota";
import { dayKeyOffset, localDayKey } from "../util/day";

/**
 * The morning digest (EP-14 Spec C) — pure section builders over the DB.
 *
 * ── Two-tier cost discipline ────────────────────────────────────────────
 * Every number here comes from deterministic SQL. The briefing job's LLM
 * writes prose *around* these figures and never computes one, because a
 * model asked to "summarize my usage" will confabulate a plausible number
 * far more readily than it will say it doesn't know. Sections are
 * therefore data, and the model's job is voice.
 *
 * ── The one-line contract ───────────────────────────────────────────────
 * `renderDigest` produces the actual iMessage body, and it has to survive
 * being read on a lock screen: numbered items so "accept 2" is
 * unambiguous, no markdown (iMessage doesn't render it), and the reply
 * grammar restated every time because nobody memorizes it.
 */

export interface NeedsAttention {
  id: string;
  title: string;
  status: string;
  /** 'gate_failed' etc. when the run said why. */
  reason: string | null;
}

export interface DigestProposal {
  /** 1-based, and the number the user replies with. */
  n: number;
  id: string;
  title: string;
}

export interface DigestUsage {
  provider: string;
  totalTokens: number;
  turns: number;
  /** Percentage of the window consumed, when a quota source reported one. */
  usedPct: number | null;
  /** Age of that percentage in minutes. Null when there's no reading. */
  quotaAgeMinutes: number | null;
  planName: string | null;
}

export interface Digest {
  day: string;
  needsAttention: NeedsAttention[];
  /** Numbered so a reply can name one. */
  proposals: DigestProposal[];
  inboxTotal: number;
  usage: DigestUsage[];
  generatedAt: string;
}

/** Tasks a human has to look at. */
export function buildNeedsAttention(limit = 5): NeedsAttention[] {
  const out: NeedsAttention[] = [];
  for (const task of listTasks({ status: "failed" })) {
    out.push({
      id: task.id,
      title: task.title,
      status: "failed",
      reason: null,
    });
  }
  // Queued is included because a task stuck behind the cap overnight is
  // indistinguishable from a forgotten one, and the digest is the only
  // place that difference surfaces.
  for (const task of listTasks({ status: "queued" })) {
    out.push({ id: task.id, title: task.title, status: "queued", reason: null });
  }
  return out.slice(0, limit);
}

/**
 * The top proposals, numbered.
 *
 * Newest first: an idea generated last night is the one the user has
 * context for. Older proposals age out via the archive sweep rather than
 * competing for these three slots forever.
 */
export function buildProposals(limit = 3): DigestProposal[] {
  return listBacklog({ status: "proposed", stage: "inbox" })
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, limit)
    .map((item, index) => ({
      n: index + 1,
      id: item.id,
      title: item.title,
    }));
}

/** Usage over the trailing week, per provider. */
export function buildUsage(now: Date = new Date()): DigestUsage[] {
  const range = { fromDay: dayKeyOffset(now, 6), toDay: localDayKey(now) };
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const quota = quotaStatus(undefined, nowSeconds);

  return usageBy("provider", range)
    .filter((slice) => slice.total_tokens > 0 || slice.turns > 0)
    .map((slice) => {
      const provider = slice.key as "claude" | "codex" | "google";
      // Prefer the weekly window — that's the cap people plan around.
      const reading =
        quota.find((q) => q.provider === provider && q.window === "week") ??
        quota.find((q) => q.provider === provider) ??
        null;
      return {
        provider,
        totalTokens: slice.total_tokens,
        turns: slice.turns,
        usedPct: reading?.used_pct ?? null,
        quotaAgeMinutes: reading
          ? Math.round(reading.ageSeconds / 60)
          : null,
        planName: getSubscription(provider)?.plan_name ?? null,
      };
    });
}

export function buildDigest(now: Date = new Date()): Digest {
  return {
    day: localDayKey(now),
    needsAttention: buildNeedsAttention(),
    proposals: buildProposals(),
    inboxTotal: inboxCount(),
    usage: buildUsage(now),
    generatedAt: now.toISOString(),
  };
}

function fmtTokens(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1_000)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${(n / 1_000_000_000).toFixed(1)}B`;
}

/**
 * Render the digest as a plain-text iMessage body.
 *
 * Plain text on purpose — iMessage renders no markdown, so asterisks and
 * backticks would show up as literal punctuation. Kept short enough to
 * read without expanding the notification, which is the whole point of
 * sending it to a phone.
 */
export function renderDigest(digest: Digest): string {
  const lines: string[] = ["⚓ DryDock"];

  if (digest.needsAttention.length > 0) {
    const failed = digest.needsAttention.filter((t) => t.status === "failed");
    const queued = digest.needsAttention.filter((t) => t.status === "queued");
    const parts: string[] = [];
    if (failed.length > 0) parts.push(`${failed.length} failed`);
    if (queued.length > 0) parts.push(`${queued.length} queued`);
    lines.push(`${digest.needsAttention.length} need attention (${parts.join(", ")})`);
  } else {
    lines.push("Nothing needs attention.");
  }

  for (const usage of digest.usage) {
    const label = usage.provider === "google" ? "Google" : usage.provider;
    if (usage.usedPct !== null) {
      // A percentage without its age reads as current. On a phone,
      // where the reading may be hours old, that matters more.
      const age =
        usage.quotaAgeMinutes !== null && usage.quotaAgeMinutes > 90
          ? ` (${Math.round(usage.quotaAgeMinutes / 60)}h old)`
          : "";
      lines.push(`${label} week ${Math.round(usage.usedPct)}%${age}`);
    } else {
      // No sanctioned quota source. Report consumption, and don't
      // pretend to a percentage.
      lines.push(`${label} ${fmtTokens(usage.totalTokens)} tokens this week`);
    }
  }

  if (digest.proposals.length > 0) {
    const list = digest.proposals
      .map((p) => `(${p.n}) ${p.title}`)
      .join(", ");
    lines.push(`${digest.proposals.length} proposed: ${list}`);
    // Restated every time: nobody memorizes a reply grammar they use
    // once a day, half-awake.
    lines.push("Reply: accept N / drop N / burn N / brief");
  } else if (digest.inboxTotal > 0) {
    lines.push(`${digest.inboxTotal} in the inbox to sweep.`);
  }

  return lines.join("\n");
}

// ── Reply parsing ───────────────────────────────────────────────────────

export type ReplyAction = "accept" | "drop" | "burn" | "brief";

export interface ParsedReply {
  action: ReplyAction;
  /** The 1-based digest number, or null for `brief`. */
  n: number | null;
}

export interface ReplyResult {
  commands: ParsedReply[];
  /** Fragments that didn't parse. Non-empty means: ask, don't guess. */
  unrecognized: string[];
}

const COMMAND = /^(accept|drop|burn)\s*#?\s*(\d{1,3})$/i;

/**
 * Parse a reply like `accept 2, burn 1`.
 *
 * ── Never guess ─────────────────────────────────────────────────────────
 * Anything that doesn't parse cleanly lands in `unrecognized`, and the
 * caller's contract is to reply "didn't understand" rather than act on a
 * best guess. This runs on text typed one-handed from a lock screen and
 * the actions mutate a real backlog — the cost of asking again is a
 * second message; the cost of a wrong guess is silent, and lands on the
 * wrong item.
 *
 * A reply containing ANY unrecognized fragment executes nothing: partial
 * execution of a garbled command is the worst outcome, because the user
 * can't tell which half ran.
 */
export function parseReply(text: string): ReplyResult {
  const result: ReplyResult = { commands: [], unrecognized: [] };
  if (typeof text !== "string") return result;

  const fragments = text
    .split(/[,;\n]+|\band\b/i)
    .map((f) => f.trim())
    .filter((f) => f.length > 0);

  for (const fragment of fragments) {
    if (/^brief$/i.test(fragment)) {
      result.commands.push({ action: "brief", n: null });
      continue;
    }
    const match = fragment.match(COMMAND);
    if (!match) {
      result.unrecognized.push(fragment);
      continue;
    }
    result.commands.push({
      action: match[1].toLowerCase() as ReplyAction,
      n: Number.parseInt(match[2], 10),
    });
  }

  return result;
}

/**
 * True when a reply is safe to execute — parsed cleanly, and every
 * command names a number the digest actually offered.
 *
 * The out-of-range check matters: "accept 7" against a three-item digest
 * is a typo, not an instruction, and silently ignoring it would leave the
 * user believing something was accepted.
 */
export function replyIsExecutable(
  reply: ReplyResult,
  digest: Digest,
): { ok: boolean; reason: string | null } {
  if (reply.unrecognized.length > 0) {
    return {
      ok: false,
      reason: `didn't understand: ${reply.unrecognized.join(", ")}`,
    };
  }
  if (reply.commands.length === 0) {
    return { ok: false, reason: "no commands found" };
  }
  for (const command of reply.commands) {
    if (command.n === null) continue;
    if (!digest.proposals.some((p) => p.n === command.n)) {
      return {
        ok: false,
        reason: `there's no item ${command.n} in today's digest`,
      };
    }
  }
  return { ok: true, reason: null };
}
