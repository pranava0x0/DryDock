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

---

## 2026-08-05 — second run (first run off the script)

Ran `git pull --ff-only` (3 commits behind: the Dependabot consolidation work),
then `scripts/daily-sweep.sh`. Whole discovery pass was one script call —
no subagents, no per-repo `gh` round-trips.

**NEW SINCE LAST RUN — 3 items**, against 35 known fingerprints:

| New item | Read as |
|---|---|
| `nucleardeployment#4` — "Plan the LWR and SMR refocus against measured scope impact" | Opened today by the user. Proposal-only, and it ends with **three blocking scope questions**. Not stale; it's live work waiting on a decision. |
| `nucleardeployment#5` — "Plan the SMR gigawatt race and add the company research base" | Opened today by the user, 983 additions. Same story — hours old, not a sweep finding. |
| `roboticsleadership#149` — `[bot] data(news): auto-scrape 2026-08-04` | The seventh consecutive unmerged auto-scrape PR. **This one is a finding.** |

Everything else in FULL STATE was unchanged from yesterday and was not re-read.

### The one genuinely new finding

`roboticsleadership` has opened one auto-scrape PR per day since 2026-07-30 —
#143, #144, #145, #146, #147, #148, #149 — and **none have merged**. No CI checks
run on any of them, so nothing is mechanically blocking the queue; the pipeline
just has no merge step. Net effect: the published robotics data is ~6 days stale
while seven PRs sit there looking like the pipeline is working. That's the
"failure that looks like success" shape CLAUDE.md names — a scraper that runs
daily, succeeds daily, and publishes nothing.

Yesterday's run saw six of these and deliberately skimmed past them as bot noise.
Seven days with zero merges is a pattern rather than a blip, so it became a task
today. Filed, not fixed — and explicitly *not* bulk-closed, since the user isn't
present.

### Backlog corrections (the point of the routine)

`GET /api/backlog` first, per the checklist, so nothing was re-filed. All 9 of
yesterday's tasks were still open; two needed correcting rather than duplicating:

- **"Triage 5 stale Dependabot PRs on DryDock (#9-#13)" → `done`.** Resolved
  while the sweep wasn't looking: PRs #16, #17, #21 merged and #18/#19/#20/#22
  closed. DryDock now has **0 open PRs**. Marking done is reversible and is what
  "keep the backlog honest" means; nothing was deleted.
- **"Close out 4 long-open personal PRs" → retitled to 5 and rewritten.** Its
  description named `nucleardeployment#1`, which has since been closed, and
  missed #4 and #5. Now lists the real set and records that #4 is blocked on
  three named scope questions.

One new task filed: the roboticsleadership merge-step gap. Backlog went 18 → 19
items.

**Apple Notes:** `pushedItems: 18, pulledNew: 0, pulledUpdated: 0` — clean, no
note-side edits to reconcile.

**GitHub mirror:** read the field rather than assuming — `status: "disabled",
reason: "no tracker repo configured"`. Same undecided call as yesterday, already
tracked as its own task.

### Deliberately not done

- **Did not file the two nuclear PRs as tasks.** They're hours old and are the
  user's own in-flight work. Folding them into the existing long-open-PR task
  keeps them visible without inventing a duplicate; if they go quiet they'll
  age into that task on their own.
- **Did not touch the 6 May test rows, 2 stale branches, or 7 bot PRs.** All
  still safe to delete, still not deleted — no user present to confirm.
- **Did not re-derive FULL STATE.** 32 unchanged rows were read as context and
  nothing more, which is the whole point of the fingerprint diff.

### Routine improvement shipped this run

Yesterday's note said: *if the NOTRK list is still 9 next run, stop reporting it.*
It was 8, and it's the permanent resting state of every local-only project — so
FULL STATE now collapses it to a single count line instead of eight. The
fingerprints are unchanged, so a checkout that newly gains or loses an upstream
still surfaces **by name** in the NEW section; only the daily restatement is
suppressed. `--full` still lists them.

Verified with `--no-save`: 8 NOTRK lines → 1 summary line, item count still
correct at 36, and the state file stayed at 35 fingerprints (unclobbered).

### For the next run

- Same starting point: `scripts/daily-sweep.sh`, read only the NEW section.
- Check `nucleardeployment#4`/`#5` — if either is still open and unanswered in a
  week, the long-open-PR task is where it belongs, not a new one.
- The bot-PR count is the thing to watch. If `roboticsleadership` is at 8+ open
  auto-scrape PRs next run, the filed task didn't get picked up and it's worth
  raising the priority rather than re-filing.
- Consider teaching the script to flag *runs* of same-prefix bot PRs (N open from
  one repo) so the accumulation shows up as one NEW line instead of one per day.

### Addendum — the sweep broke the thing it was auditing (DD-020)

Filed as **DD-020** in [issues.md](../issues.md). Worth reading before the next run,
because it changes what this routine is allowed to do.

Correcting the long-open-PR task's title (`4` → `5`) turned out to mint a
**phantom duplicate on every sync**. The count went 1 → 2 over two syncs and
would have kept climbing; the `/backlog` page auto-syncs every 30 s, so an open
tab would have run it away.

The mechanism, confirmed by hashing the titles directly:

```
lineId("Close out 4 long-open personal PRs across repos") = 4c0e829060ca3bfc
lineId("Close out 5 long-open personal PRs across repos") = a9a2764293b4a2c9
row.external_id                                            = 4c0e829060ca3bfc  ← stale
```

`external_id` is a hash of the *rendered line text*, so a rename orphans it. The
pull's by-external_id lookup misses, and neither rescue path fires: the by-title
claim is gated on `external_id === null` (a renamed row's is non-null-but-stale),
and the "Rename in Notes" 1-orphan/1-deferred heuristic only considers
`source: "apple-notes"` rows, while UI/API-created rows are `source: "manual"`.
So the line lands in `deferredCreates` and becomes a new row — again, every sync.

The module docstring at `backlog.ts:225-229` says a UI rename "round-trips
cleanly" via the by-title fallback. It doesn't. **The doc describes the intended
design; the gate on line 311 prevents it.** That gap is why nothing caught this —
the behaviour reads as correct in the comments and there's no test that renames a
`manual` row and syncs twice.

**Contained, not fixed.** Deleted the two phantoms (empty description, priority 0,
created minutes earlier by this run — my own artifacts, not user data), then
reverted the title to the exact original string so the hash matches again.
Verified: two consecutive syncs at `pulledNew: 0`, 19 items, zero duplicate
titles. The corrected count now lives in the item's *description*, which doesn't
feed the hash, and the title carries a `TITLE IS DELIBERATELY STALE` marker.

**New standing rule for this routine, until DD-020 is fixed: do not PATCH a
backlog item's title.** Corrections go in the description. Filing new items with
`POST` is safe — it stamps `external_id = lineId(title)` at creation, so those
round-trip correctly (verified: filing the DD-020 task itself synced at
`pulledNew: 0`).

Two things this run got wrong that are worth naming:

1. **I kept syncing while diagnosing.** The delete-then-sync attempt *added* a
   phantom rather than removing one, because each sync re-mints. Should have
   stopped mutating at the first unexplained `pulledNew: 1` and read the code —
   which is what finally settled it in about two minutes.
2. **`pulledNew: 1` was reported and nearly waved through** as a benign note-side
   edit. It was the bug announcing itself. Any non-zero `pulledNew` on a run
   where nobody touched the Notes app is a defect until proven otherwise.
