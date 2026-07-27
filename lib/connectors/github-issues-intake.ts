import { listBacklog, updateBacklogItem } from "../db/backlog";
import { listProjects } from "../db/projects";
import { intakeCapture } from "../orchestrator/intake";
import { slugify } from "../orchestrator/capture";
import type { GithubIssue, GithubWork } from "./github-work";

/**
 * GitHub issues → the backlog (the pull half of EP-13's spoke).
 *
 * An issue is a unit of intended work, which is what a backlog item is —
 * so unlike pull requests, issues genuinely belong in this list.
 *
 * ── Opening an issue is a deliberate act, so it lands pre-triaged ───────
 * The inbox exists to keep *raw captures* out of the trusted list.
 * Someone who opened a GitHub issue already sat down, picked a repo,
 * wrote a title, and clicked submit — putting that through a triage
 * queue would be asking them to approve their own decision twice. Same
 * reasoning as Apple Notes lines. (Machine-generated issues would be
 * different, which is why this only imports issues authored by the user.)
 *
 * ── Closing is the DB's job, not this connector's ──────────────────────
 * This is the pull direction only: it creates and refreshes rows. It
 * never closes an issue and never deletes a row, because a one-way
 * connector can't cause an echo loop — and the Notes sync taught this
 * codebase that echo loops are where the hard bugs live.
 */

export interface GithubIssueImport {
  created: number;
  updated: number;
  duplicates: number;
  linked: number;
  status: "ok" | "unavailable";
  reason: string | null;
}

/** `owner/repo#42` — the stable, human-readable reference we stamp. */
export function issueRef(issue: GithubIssue): string {
  return `${issue.repository}#${issue.number}`;
}

/**
 * Match a repo to a DryDock project by name.
 *
 * `pranava0x0/ppa-helper` → a project named "PPA Helper"; the slugify
 * comparison collapses case, spaces, and dashes. An ambiguous match
 * yields null — an unassigned backlog row is visible and one tap from
 * fixed, while a wrongly-assigned one looks right and hides.
 */
export function matchRepoToProject(
  repository: string,
  projects: Array<{ id: string; name: string }>,
): string | null {
  const repoName = slugify(repository.split("/").pop() ?? "");
  if (repoName.length === 0) return null;
  const matches = projects.filter((p) => slugify(p.name) === repoName);
  return matches.length === 1 ? matches[0].id : null;
}

export async function importGithubIssues(
  work: GithubWork,
): Promise<GithubIssueImport> {
  if (work.status !== "ok") {
    return {
      created: 0,
      updated: 0,
      duplicates: 0,
      linked: 0,
      status: "unavailable",
      reason: work.reason,
    };
  }

  const projects = listProjects().map((p) => ({ id: p.id, name: p.name }));
  const result: GithubIssueImport = {
    created: 0,
    updated: 0,
    duplicates: 0,
    linked: 0,
    status: "ok",
    reason: work.reason,
  };

  // Rows already carrying a ref, so an issue that was mirrored *out* by
  // EP-13's push isn't re-imported as if it were new.
  const byRef = new Map(
    listBacklog()
      .filter((i) => i.github_issue_ref)
      .map((i) => [i.github_issue_ref as string, i]),
  );

  for (const issue of work.issues) {
    const ref = issueRef(issue);
    if (byRef.has(ref)) {
      result.duplicates += 1;
      continue;
    }

    const outcome = intakeCapture({
      text: issue.title,
      source: "github",
      externalId: `github:${ref}`,
      projectId: matchRepoToProject(issue.repository, projects),
      description: `GitHub issue ${ref}${
        issue.labels.length > 0 ? ` · ${issue.labels.join(", ")}` : ""
      }\n${issue.url}`,
    });

    if (outcome.item) {
      // Stamp the ref even when the title already existed as a manual
      // row: linking them is what stops the next sync from creating a
      // duplicate, and it gives the row a link out.
      updateBacklogItem(outcome.item.id, {
        github_issue_ref: ref,
        // An issue the user opened themselves is already a decision.
        triaged_at:
          outcome.item.triaged_at ?? Math.floor(Date.now() / 1000),
      });
      result.linked += 1;
    }

    if (outcome.outcome === "created") result.created += 1;
    else if (outcome.outcome === "updated") result.updated += 1;
    else result.duplicates += 1;
  }

  return result;
}
