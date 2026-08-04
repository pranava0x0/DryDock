# Daily sweep log

Running log for the `drydock-daily` scheduled task. One section per run: what the
sweep found, what became a task, and what changed about the routine itself.

**How to run it:** `scripts/daily-sweep.sh` does the whole discovery pass — GitHub
PRs/issues across every `pranava0x0` repo, plus every local checkout's dirty /
ahead-behind / no-upstream state — and prints a **NEW SINCE LAST RUN** section by
diffing fingerprints against `~/.drydock/sweep-state.txt`. On a quiet day that
section is empty and the run costs almost nothing. Use `--full` to re-print
everything, `--no-save` to leave the state file alone.

Apple Notes sync is `POST /api/backlog/sync` against a running dev server
(`npm run dev`, or the `drydock-dev` launch config). It needs no auth from
localhost.

---

## 2026-08-04 — first run (baseline)

Nothing existed before this run: no script, no state file, no log. The whole
sweep was manual, which is what motivated `scripts/daily-sweep.sh`.

**Apple Notes:** synced clean. First pass pushed 9 items, second pushed 18 after
the new tasks were added. `pulledNew: 0 / pulledUpdated: 0` both times — no
note-side edits to reconcile.

**GitHub mirror:** `status: disabled — no tracker repo configured`. That is the
undecided tracker-repo call in DD-BL-39, so it became a task rather than a
silent zero.

**Open issues across all repos:** zero. Genuinely none, not a search failure —
`gh search issues --owner pranava0x0 --state open` returns empty.

### What the sweep found

| Finding | Detail |
|---|---|
| 5 stale Dependabot PRs on DryDock | #9–#13, untouched since 2026-07-27. Three are major bumps (vitest 2→4, nanoid 5→6, @types/node 22→26). |
| `vibe-coding-security` checkout diverged | 55 commits ahead **and** 98 behind `origin/main` — local HEAD 2026-07-02, remote pushed 2026-08-04 — plus 4 untracked files. This is the advisory source CLAUDE.md points every session at. |
| KeepInTouch | 5 uncommitted source files (both connectors, the web JS, its tests). |
| DryDock DB backlog | 6 May test rows (`test at 8:10am`, `8:23am test`, …) plus one item — "create a repo and skill for security updates" — that shipped and was never closed. They ride along to Apple Notes on every sync. |
| FERC Document Analysis | 5 untracked `data/seeds/*_audits.json` state-PUC files; dataset isn't reproducible from the repo. |
| Tarrif Refunds | the whole `tariffrefundiq/` subtree is untracked. |
| 4 long-open personal PRs | teaching-ideas#1/#2, nucleardeployment#1, dcelectionstracker#21 — all authored by the user, oldest from 2026-06-11. |
| 2 stale local DryDock branches | `claude/dazzling-kalam-59c75c` (1 docs commit, 2026-05-24) and `jam/website-session-kickoff-0a396b` (already squash-merged as PR #14). |
| 4 stale-but-clean checkouts | FERC Document Analysis (13 behind), FERC Show Cause Orders (7), Personal Website (6), Settle (4). Noise-level; logged, not tasked. |

All nine of the actionable rows were written to the live backlog via
`POST /api/backlog` and pushed to Apple Notes.

### Deliberately not done

- **Did not delete anything.** The 6 test rows, the 2 stale branches, and the
  stale bot PRs are all safe to remove, but deletion is irreversible and the
  user wasn't present to confirm. Each is a task instead.
- **Did not merge the Dependabot PRs.** Three are major-version bumps and
  CLAUDE.md requires an advisory check against `vibe-coding-security` first —
  which is itself in a diverged state, so that check couldn't be trusted today.

### Routine improvements shipped this run

1. `scripts/daily-sweep.sh` — the entire discovery pass, no agent, no per-repo
   `gh` round-trips from the model's context.
2. Fingerprint state in `~/.drydock/sweep-state.txt` so the next run reports
   only what changed. Verified: a second consecutive run printed an empty
   **NEW SINCE LAST RUN** section against 43 known items.
3. Fingerprints encode *state*, not dates — `dirty:<repo>:<count>`,
   `sync:<repo>:<ahead>:<behind>`. A checkout that gets worse resurfaces; one
   sitting still stays quiet. Never put the run date in a fingerprint or every
   line is new every day.
4. Bot PRs are labelled `[bot]` inline so a daily auto-scrape repo
   (roboticsleadership pushes one PR/day) can be skimmed past rather than
   re-triaged.
5. **Caught in self-review (PR #15):** the first cut ran both `gh search` calls
   with `2>/dev/null`, so an expired token or a rate limit produced zero lines —
   indistinguishable from today's genuine "zero open issues across all repos" —
   and then *saved that empty result as the new baseline*, which would have made
   every PR report as NEW on the next working run. Exit status is now checked
   explicitly; a failure prints the actual `gh` error, marks the run PARTIAL, and
   refuses to write the state file. This is the "failure that looks like success"
   class CLAUDE.md names, found in the very tool built to avoid wasted re-reads.

### Verification of the script itself

| Case | Expected | Result |
|---|---|---|
| Fresh state file | every item listed as NEW | 44 of 44 ✓ |
| Second consecutive run | empty NEW section | empty ✓ |
| `gh` returning HTTP 401 | loud error, PARTIAL banner, state preserved | errors surfaced; state stayed at 44 fingerprints rather than being clobbered to the local-only 26 ✓ |

### For the next run

- Start from `scripts/daily-sweep.sh` output; only read further into anything in
  the **NEW** section.
- Check whether the 9 tasks filed today are still open before re-filing them —
  `GET /api/backlog` is one call and is cheaper than re-deriving them.
- The `NOTRK` (no upstream) list is 9 repos and is almost certainly permanent
  for local-only projects. If it's still 9 next run, stop reporting it.
