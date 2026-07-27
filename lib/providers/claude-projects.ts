/**
 * Turning a Claude Code session log into a project name (DD-BL-38).
 *
 * ── The dash collision ──────────────────────────────────────────────────
 * Claude Code stores sessions under `~/.claude/projects/<encoded-cwd>/`,
 * where the encoding flattens the working directory by replacing `/`, `.`
 * AND spaces with `-`. Three different characters collapse onto one, so
 * the encoding is **not invertible** (anthropics/claude-code#7009).
 *
 * A real directory on this machine:
 *
 *   -Users-pranava-Projects-Robotics-Leadership--claude-worktrees-…
 *
 * decodes naively to `/Users/pranava/Projects/Robotics/Leadership/...`,
 * but the session's own `cwd` field says the truth is
 * `/Users/pranava/Projects/Robotics Leadership/.claude/worktrees/…` — a
 * *space*, not a separator. A dashboard built on the decoded name would
 * confidently report a project called "Robotics" that has never existed.
 *
 * ── The defense ─────────────────────────────────────────────────────────
 * Don't decode. Every real session line carries an unambiguous absolute
 * `cwd`; read the project key from that. The directory name is only a
 * last-resort fallback for a session that recorded no `cwd` at all (a log
 * holding nothing but `ai-title` / `queue-operation` lines), and when we
 * fall back we say so — `ambiguous: true` — so callers can render
 * "unknown" instead of a guess. Never invent a project name.
 */

/** Marks the worktree root inside a project checkout. */
const WORKTREE_MARKER = "/.claude/worktrees/";

export interface ProjectKey {
  /** Display/grouping key, e.g. "Robotics Leadership". "" when unknown. */
  key: string;
  /**
   * True when the key was inferred from the lossy directory encoding
   * rather than read from a `cwd`. Callers must not present an ambiguous
   * key as fact.
   */
  ambiguous: boolean;
}

export const UNKNOWN_PROJECT: ProjectKey = { key: "", ambiguous: true };

/**
 * Project key for an absolute working directory.
 *
 * Worktrees collapse onto their parent project: a session run inside
 * `<project>/.claude/worktrees/<branch-slug>` belongs to `<project>`,
 * because that's the unit the user thinks in (and DryDock's own
 * dispatcher puts every task in exactly such a worktree — without this,
 * every dispatched task would look like its own one-off project).
 */
export function projectKeyFromCwd(cwd: string): ProjectKey {
  if (typeof cwd !== "string" || cwd.trim().length === 0) {
    return UNKNOWN_PROJECT;
  }
  let path = cwd.trim();

  const marker = path.indexOf(WORKTREE_MARKER);
  if (marker !== -1) path = path.slice(0, marker);

  // Trailing separators would otherwise make the basename empty.
  path = path.replace(/\/+$/, "");
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (name.length === 0) return UNKNOWN_PROJECT;
  return { key: name, ambiguous: false };
}

/**
 * Last-resort key from the encoded directory name, always flagged
 * ambiguous. Used only when a session log contained no `cwd` line at all.
 *
 * We deliberately do NOT try to reconstruct the path: any `-` could be a
 * separator, a literal dash, a space, or a dot, and picking one is how
 * you end up rendering a project that doesn't exist. Instead we take the
 * trailing segment as a weak hint and let the caller decide whether a
 * hint is worth showing.
 */
export function projectKeyFromEncodedDir(dirName: string): ProjectKey {
  if (typeof dirName !== "string") return UNKNOWN_PROJECT;
  const trimmed = dirName.replace(/^-+/, "").replace(/-+$/, "");
  if (trimmed.length === 0) return UNKNOWN_PROJECT;
  return { key: trimmed, ambiguous: true };
}

/**
 * True when a directory name's encoding could stand for more than one
 * real path — i.e. essentially always, once it has any dash beyond the
 * leading one. Exposed so a UI can explain *why* a key is untrusted
 * rather than just greying it out.
 */
export function isEncodingAmbiguous(dirName: string): boolean {
  return dirName.replace(/^-/, "").includes("-");
}
