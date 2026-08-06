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

---

## 2026-08-06 — third run

`git pull --ff-only` was already up to date. One `scripts/daily-sweep.sh` call
did the discovery pass — no subagents, no per-repo `gh` round-trips.

**NEW SINCE LAST RUN — 3 items**, against 35 known fingerprints:

| New item | Read as |
|---|---|
| `nucleardeployment#7` — "Capture session learnings and queue the post-merge review findings" | Opened by the user four hours before this run. Docs-only (37 additions, 4 files, zero app code). **Not a finding** — too new to chase, and it is the `/learnings` output of an active session. |
| `roboticsleadership#151` — `[bot] data(news): auto-scrape 2026-08-05` | The **eighth** consecutive unmerged auto-scrape PR. Not a new finding — it is yesterday's finding getting worse, which is exactly the trigger the 2026-08-05 run armed. |
| `SYNC Nuclear Deployment [main] 0 ahead / 25 behind` | **The one genuinely new finding.** See below. |

Everything else in FULL STATE was unchanged and was not re-read.

### The one genuinely new finding — stale local checkouts

`Nuclear Deployment` newly appearing at 25-behind is worth more than the row
suggests, because it is the repo with the *active* work: PR #7 landed there
today. A session starting from that tree reads a `main` that is 25 commits old.
That is precisely the setup for the 2026-08-05 orphan-branch lesson — duplicate
IDs and conflicting work come from stale trees, not from bad intentions.

Checking it turned one row into a class. Five checkouts are behind, and all five
are **0 ahead**, so every one is a no-risk fast-forward:

| Checkout | Behind | Clean? |
|---|---|---|
| Nuclear Deployment | 25 | clean |
| FERC Document Analysis | 13 | 5 uncommitted |
| FERC Show Cause Orders | 7 | clean |
| Personal Website | 6 | clean |
| Settle | 4 | clean |

Filed as **one** item (`3YnFTnd9BFBeWWlG24aju`, priority 52) rather than five
rows. Only Nuclear Deployment was new to the fingerprint set; the other four
have been sitting in FULL STATE unremarked, which is the failure mode of a
"only look at NEW" routine — a slowly-accumulating class never trips the diff,
because each member joined on a different day. Worth watching for elsewhere.

**Not pulled.** Four of the five would have been a safe one-liner, but running
`git pull` inside other projects' checkouts is outside this routine's remit, and
FERC Document Analysis has 5 uncommitted files that need the user's call.

### Backlog corrections

`GET /api/backlog` first, per the routine, so nothing got re-filed under a new id.

- **`OuCH4PJ5nbwt` — roboticsleadership bot PRs: priority 0 → 62.** The
  2026-08-05 run set an explicit trigger ("if it is at 8+ next run, raise the
  priority rather than re-file"). It was at 8. Raised rather than re-filed, and
  the description now carries the full list and the ~7-day staleness. The
  priority-0 it was filed at was a filing slip — every other real row has a real
  priority, so it sorted below six May test rows.
- **`c9meeDCfhKg98P7rIFf0l` — long-open PRs: description refreshed.**
  `nucleardeployment#4` and `#5` have **closed** since yesterday, which also
  retires the three blocking scope questions recorded against #4. Four personal
  PRs are open now, but only `dcelectionstracker#21` (~8 weeks) and
  `teaching-ideas#1` (3 weeks) are genuinely long-open.

**No title was PATCHed** — DD-020's standing rule held. Both edits went to
`description` and `priority`, and the run confirmed *why* that is the right
line: `renderAppleNoteBody` puts only `title` (plus a stripped ` · added` suffix)
into the note, so `lineId` hashes the title alone. Priority and description are
not in the hash and cannot orphan an `external_id`. That is now verified rather
than assumed.

### Apple Notes sync

Synced **twice** — once after filing, once to prove stability, because DD-020
showed that re-minting only reveals itself on the second pass.

```
sync 1: pushedItems 21, pulledNew 0, pulledUpdated 0
sync 2: pushedItems 21, pulledNew 0, pulledUpdated 0
```

21 items, **zero duplicate titles, zero null `external_id`s**. The new row was
stamped `external_id = ca68d1b4bbaad89c` at POST, so it round-trips.

**`mirror.status` was read, not assumed: `disabled`** — "no tracker repo
configured (Settings → Backlog mirror)". So the GitHub mirror did **not** run
this sweep. That is the already-filed item "Configure the DryDock backlog GitHub
mirror" (p65), not a new failure — but it is worth restating that a green sync
here covers Apple Notes only.

### Deliberately not done

- **Did not merge the 8 bot PRs**, or any of them. Bot-authored and data-only,
  but bulk-merging eight PRs unattended is the user's call.
- **Did not pull the five behind checkouts** (above).
- **Did not touch `nucleardeployment#7`.** Its body reports 14 review findings
  live on main and on the deployed site — that is queued in *that* repo's
  backlog and is not DryDock's to re-file.
- **Did not delete the six May test rows** or any stale branch. Standing rule.
- **Did not re-derive FULL STATE.** 32 unchanged rows were context, not a
  worklist.

### Routine improvement shipped this run

Yesterday's note asked for exactly this: *teach the script to flag runs of
same-prefix bot PRs so the accumulation shows up as one NEW line instead of one
per day.* Today made the case — `#151` was the eighth line for one condition.

`scripts/daily-sweep.sh` now buffers bot PRs and collapses them per repo once
there are `BOT_RUN_MIN` (3) or more:

```
PR  roboticsleadership — 8 open [bot] PRs, none merged (#151, #149, ... #143)
```

The fingerprint is `botrun:<repo>:<count>`, so it encodes **state, not dates** —
per the standing rule. Two consequences, both intended:

- The run reports as NEW only when the pile actually **grows or shrinks**. A
  one-in-one-out day (an old PR merges, a new one opens, count unchanged) is not
  a change in the situation and correctly stays silent.
- Below 3, each bot PR still gets its own line, so a lone Dependabot bump is
  never hidden by this.

Verified with `--no-save`: 8 bot lines → 1, item count 35 → 29 (−7 collapsed,
+1 for this repo going dirty from the edit itself), state file left alone.

### For the next run

- Same starting point: `scripts/daily-sweep.sh`, read only the NEW section.
- **The fingerprint-scheme transition is already absorbed.** After committing,
  this run was re-run with state saved, so `botrun:roboticsleadership:8` is
  baselined and the eight retired `pr:` fingerprints are gone. Next run's NEW
  section is clean — the bot line will reappear only if the count actually
  moves off 8.
- That same save also baselined two **self-referential** rows: this branch and
  `DryDock#27`. Both retire on merge, so expect them to vanish rather than to
  need triage. A sweep that opens a PR will always see its own PR next run.
- The bot-PR task is at p62 now. If the count is still 8+ *after* the user has
  seen it at that priority, stop re-reporting it and leave it to the backlog —
  raising it twice would just be nagging through a different channel.
- Watch for the failure mode this run surfaced: **a class that accumulates one
  member per day never trips the NEW diff.** The five behind-checkouts hid in
  FULL STATE for days that way. If a future run has an empty NEW section, that
  is a good moment to skim FULL STATE for a group that has quietly grown —
  which is the one legitimate reason to read it.
