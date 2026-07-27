/**
 * Who wrote this commit? (EP-11 Spec B) — pure, no I/O.
 *
 * ── What the trailers actually look like ────────────────────────────────
 * Sampled from this user's real repos:
 *
 *   Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
 *   Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>
 *   Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
 *   Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
 *   Co-authored-by: Codex <noreply@openai.com>
 *   Co-authored-by: Pranava Raparla <pranava@pranavas-air.local>   ← human!
 *
 * Two things fall out of that, and both matter:
 *
 * 1. **The email domain is the discriminator, not the name.** Human
 *    co-author trailers are common (pair commits, rebases, a second
 *    machine's git identity), so "has a Co-Authored-By → AI" would
 *    over-count badly. We match on `noreply@anthropic.com` /
 *    `noreply@openai.com`, and a name-only match never counts.
 * 2. **The capitalization varies** (`Co-Authored-By` vs
 *    `Co-authored-by`) because different tool versions wrote them. Match
 *    case-insensitively or lose a third of the data.
 *
 * ── Trailer coverage is itself a metric ─────────────────────────────────
 * Trailers only appear when the agent wrote the commit *and* the
 * convention was followed. Research on the wild ecosystem puts
 * trailer-only detection at roughly a fifth of true AI involvement. So
 * `attribution_source` records which rule fired, and the dashboard
 * renders a **coverage** figure beside any AI-share number. Transparency
 * about what we can't see beats a confident precise-looking share.
 */

export type Agent = "human" | "claude" | "codex" | "jam" | "drydock" | "gemini";

/** Which rule produced the verdict. Lower in this list = weaker evidence. */
export type AttributionSource =
  /** The branch is a DryDock worktree; the task row states the provider. */
  | "drydock-task"
  /** A recognized agent co-author trailer with a known noreply domain. */
  | "trailer"
  /** A branch-name convention (`claude/`, `jam/`, `codex/`). Coarse. */
  | "branch"
  /** Nothing indicated an agent. */
  | "none";

export interface Attribution {
  agent: Agent;
  /** Model id when the trailer named one, e.g. "Opus 4.7". '' otherwise. */
  model: string;
  source: AttributionSource;
}

export interface CommitInput {
  /** Full commit message — subject and body. Trailers live in the body. */
  message: string;
  /** Branch or ref the commit arrived on, when known. */
  branch?: string | null;
  /**
   * Provider recorded on the DryDock task, when the branch resolves to
   * one. This is ground truth and outranks everything else.
   */
  taskProvider?: Agent | null;
}

/**
 * Agent trailer domains. Keyed by the `noreply@` host because that's the
 * part a human co-author can't accidentally collide with.
 */
const AGENT_DOMAINS: Array<{ domain: string; agent: Agent }> = [
  { domain: "noreply@anthropic.com", agent: "claude" },
  { domain: "noreply@openai.com", agent: "codex" },
  { domain: "noreply@google.com", agent: "gemini" },
];

/**
 * Branch prefixes. Coarse — a prefix says which harness opened the
 * branch, not that every commit on it was machine-written, so this only
 * fires when no trailer did.
 *
 * `jam/*` is a second orchestrator seen across several of this user's
 * repos; `drydock/*` is this app's own worktree convention.
 */
const BRANCH_PREFIXES: Array<{ prefix: string; agent: Agent }> = [
  { prefix: "drydock/", agent: "drydock" },
  { prefix: "claude/", agent: "claude" },
  { prefix: "codex/", agent: "codex" },
  { prefix: "jam/", agent: "jam" },
];

const TRAILER = /^\s*co-authored-by:\s*(.*?)\s*<([^>]+)>\s*$/i;

export function attributeCommit(input: CommitInput): Attribution {
  // 1. Ground truth: DryDock dispatched it and knows which provider ran.
  if (input.taskProvider) {
    return { agent: input.taskProvider, model: "", source: "drydock-task" };
  }

  // 2. Trailers. Strongest available evidence for a commit we didn't
  //    dispatch ourselves, and the only one that names a model.
  const trailer = findAgentTrailer(input.message);
  if (trailer) return trailer;

  // 3. Branch convention. Coarse, so it's last.
  const branch = (input.branch ?? "").trim();
  if (branch.length > 0) {
    // Strip a remote prefix so `origin/claude/foo` still matches.
    const normalized = branch.replace(/^(refs\/heads\/|origin\/|remotes\/[^/]+\/)/, "");
    for (const { prefix, agent } of BRANCH_PREFIXES) {
      if (normalized.toLowerCase().startsWith(prefix)) {
        return { agent, model: "", source: "branch" };
      }
    }
  }

  // 4. Unattributed is a human. Not "unknown": absence of every agent
  //    marker is the best evidence available that a person wrote it, and
  //    a third bucket called "unknown" would just be a place for the
  //    honest answer to hide.
  return { agent: "human", model: "", source: "none" };
}

function findAgentTrailer(message: string): Attribution | null {
  if (typeof message !== "string" || message.length === 0) return null;
  for (const line of message.split(/\r?\n/)) {
    const match = line.match(TRAILER);
    if (!match) continue;
    const name = match[1];
    const email = match[2].toLowerCase();
    const known = AGENT_DOMAINS.find((d) => email.endsWith(d.domain));
    // A human co-author trailer lands here and is correctly skipped —
    // counting it would inflate the AI share with the user's own commits.
    if (!known) continue;
    return {
      agent: known.agent,
      model: extractModel(name, known.agent),
      source: "trailer",
    };
  }
  return null;
}

/**
 * Pull the model out of a trailer name.
 *
 *   "Claude Opus 4.7"             → "Opus 4.7"
 *   "Claude Opus 4.6 (1M context)" → "Opus 4.6"
 *   "Claude"                      → ""      (older trailers named no model)
 *   "Codex"                       → ""      (OpenAI's trailer is static)
 *
 * The parenthetical is dropped: "Opus 4.6" and "Opus 4.6 (1M context)"
 * are the same model with a different context window, and splitting them
 * into two legend entries would make the model mix read as more
 * fragmented than it is.
 */
export function extractModel(name: string, agent: Agent): string {
  const trimmed = name.replace(/\s*\([^)]*\)\s*/g, " ").trim();
  if (trimmed.length === 0) return "";
  const vendor = agent === "claude" ? "claude" : agent === "codex" ? "codex" : "";
  if (vendor && trimmed.toLowerCase() === vendor) return "";
  if (vendor && trimmed.toLowerCase().startsWith(`${vendor} `)) {
    return trimmed.slice(vendor.length + 1).trim();
  }
  return trimmed;
}

// ── Aggregation ─────────────────────────────────────────────────────────

export interface AttributedCommit {
  agent: Agent;
  model: string;
  source: AttributionSource;
  additions: number;
  deletions: number;
}

export interface AttributionShare {
  agent: Agent;
  commits: number;
  additions: number;
  deletions: number;
  /** Share of commits, 0–1. */
  share: number;
}

export interface AttributionSummary {
  totalCommits: number;
  byAgent: AttributionShare[];
  /** Model breakdown within agent commits, most-used first. */
  byModel: Array<{ agent: Agent; model: string; commits: number }>;
  /**
   * Fraction of non-human commits that carried an explicit trailer, as
   * opposed to being inferred from a branch name. Rendered beside every
   * AI-share number so a coarse inference is never mistaken for a
   * measurement.
   */
  trailerCoverage: number;
  /** Share of all commits attributed to some agent, 0–1. */
  aiShare: number;
}

export function summarizeAttribution(
  commits: AttributedCommit[],
): AttributionSummary {
  const byAgent = new Map<Agent, AttributionShare>();
  const byModel = new Map<string, { agent: Agent; model: string; commits: number }>();
  let agentCommits = 0;
  let trailerAttributed = 0;

  for (const commit of commits) {
    const entry = byAgent.get(commit.agent) ?? {
      agent: commit.agent,
      commits: 0,
      additions: 0,
      deletions: 0,
      share: 0,
    };
    entry.commits += 1;
    entry.additions += Math.max(0, commit.additions);
    entry.deletions += Math.max(0, commit.deletions);
    byAgent.set(commit.agent, entry);

    if (commit.agent !== "human") {
      agentCommits += 1;
      if (commit.source === "trailer" || commit.source === "drydock-task") {
        trailerAttributed += 1;
      }
      if (commit.model) {
        const key = `${commit.agent}|${commit.model}`;
        const model = byModel.get(key) ?? {
          agent: commit.agent,
          model: commit.model,
          commits: 0,
        };
        model.commits += 1;
        byModel.set(key, model);
      }
    }
  }

  const total = commits.length;
  for (const entry of byAgent.values()) {
    entry.share = total === 0 ? 0 : entry.commits / total;
  }

  return {
    totalCommits: total,
    byAgent: [...byAgent.values()].sort((a, b) => b.commits - a.commits),
    byModel: [...byModel.values()].sort((a, b) => b.commits - a.commits),
    // 1 when there are no agent commits at all: "we inferred nothing
    // coarsely" is full coverage, not zero.
    trailerCoverage: agentCommits === 0 ? 1 : trailerAttributed / agentCommits,
    aiShare: total === 0 ? 0 : agentCommits / total,
  };
}
