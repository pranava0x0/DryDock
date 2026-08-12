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
+1 for this repo going dirty from the edit itself), state file left alone. Then
exercised directly against a synthetic fixture at 12 / 3 / 1 bot PRs to check
all three branches: capped-with-`+4 more`, collapsed-at-the-threshold, and
left-alone-below-it.

Two defects in that first cut, both caught reviewing my own diff:

- The line read **"N open [bot] PRs, none merged"**. The script only queries
  *open* PRs — it never looked at merge history, so "none merged" was a claim
  it had no basis for. True for `roboticsleadership` today, but a repo with 3
  open bot PRs and 200 merged ones would have been described as a stalled
  pipeline, and a future run would file a task on it. Now reads "N open".
- **No cap on the enumerated numbers.** `gh search --limit 60` means one repo
  could render a 60-number line — the exact noise this pass exists to delete.
  Capped at 8 with `+N more`.

### Second routine fix — the sweep can die before it saves

Found the hard way: **`scripts/daily-sweep.sh | head -12` kills the run before
the state save.** `head` exits, stdout closes, the next `echo` takes SIGPIPE,
and the script dies at the bottom of the output — after printing everything
that makes it look like a complete run, and before writing
`~/.drydock/sweep-state.txt`.

I did this to myself mid-run: piped a real save-enabled run into `head -12`,
saw normal-looking output, and only noticed the state was untouched when a
fingerprint I had just baselined still reported as NEW. Another instance of the
house bug class — *the unhappy path is indistinguishable from the happy one*.
The failure direction is safe (items get re-reported, never dropped), but it
silently wastes the next run.

Fixed with `trap '' PIPE` at the top, so the writes fail harmlessly and the run
still reaches the save. Verified: `daily-sweep.sh | head -3` now leaves a
*changed* state file (hash compared before/after).

**Standing note for this routine: never pipe the sweep into `head` or `less`
on a save-enabled run.** The trap covers it now, but redirect to a file and read
that if you want to skim — `> /tmp/sweep.txt`.

### For the next run

- Same starting point: `scripts/daily-sweep.sh`, read only the NEW section.
- **The fingerprint-scheme transition is absorbed.** `botrun:roboticsleadership:8`
  is baselined and the eight `pr:roboticsleadership#NNN` fingerprints are
  retired (confirmed: zero left in the state file). A final `--no-save` run
  printed an **empty NEW section**, so the next run starts quiet and the bot
  line reappears only if the count actually moves off 8.
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

---

## 2026-08-07 — fourth run

`git pull --ff-only` was already up to date. One `scripts/daily-sweep.sh` call
did the discovery pass — no subagents, no per-repo `gh` round-trips.

**NEW SINCE LAST RUN — 2 items**, against 27 known fingerprints. Neither is a
finding, and nothing was filed. The interesting output of this run is what the
NEW section's own behaviour revealed about the fingerprint scheme.

| New item | Read as |
|---|---|
| `roboticsleadership — 9 open [bot] PRs` | Yesterday's collapsed bot-run line, one higher. **Not a finding, and deliberately not re-raised** — the 2026-08-06 run filed it at p62 and left a standing note that raising it twice is nagging through a second channel. It is, however, the trigger for this run's script fix. |
| `nucleardeployment#9` — "Cache every source locally, validate each claim against it, and record today's criticality" | Opened by the user ~12 h before this run (207 files, +19,165/−12), `MERGEABLE`, no reviews, no CI. **Not a finding** — same read as `nucleardeployment#7` on 2026-08-06: too new to chase, and it is an active session's own output. It is *not* covered by the p55 "4 long-open personal PRs" task either, which is scoped to PRs that have gone stale; a 12-hour-old PR has not. |

### Routine improvement shipped this run — a daily drip defeats a count-exact fingerprint

The bot-run collapse shipped yesterday worked exactly as designed and was still
wrong, for a reason yesterday's run could not have seen from one day of data.

The fingerprint was `botrun:<repo>:<count>`. That correctly encodes *state* per
the standing rule, and correctly stays quiet on a one-in-one-out day. But
`roboticsleadership` is fed by a **daily** scraper, so the count grows by exactly
one every morning — `…:8` → `…:9` → `…:10` — and a fingerprint that includes the
exact count is therefore **guaranteed to report NEW every single day, forever**,
for a standing condition that already has a filed backlog task. Yesterday's log
predicted the symptom ("if the count is still 8+ … stop re-reporting it") and
put the fix in the *prompt*, as a rule for me to remember. The standing rule for
this routine says to put it in the *script*.

The count is now banded before it is fingerprinted:

```
bot_band: le5 | le10 | le20 | le50 | gt50
emit "botrun:$botrepo:$(bot_band "$count")"  "PR  $botrepo — $count open [bot] PRs (…)"
```

The rendered line still shows the **exact** count — only the diff is coarse. So
the drip goes quiet, and the line speaks up again only when the pile changes
magnitude (10 → 11, or a cleanup dropping it to 4). Boundaries were checked
directly against the extracted function at 1/2/3/5/6/8/9/10/11/20/21/50/51/120 —
all fourteen land in the intended band.

Bands are named by their **upper** bound (`le10`), not as ranges (`6-10`). That
was a defect caught reviewing my own diff before anything was baselined: a
`3-5` label hardcodes `BOT_RUN_MIN`'s current value from twenty lines away and
would start silently lying if that threshold ever moved. The band string is an
opaque fingerprint key that is never displayed, so it should not imply a lower
bound it does not enforce.

**This is the second instance of one bug class in two days.** Yesterday: a
fingerprint containing a date makes every line new every day. Today: a
fingerprint containing an exact count makes a *daily-incrementing* line new every
day. Same failure, one level subtler — the value is legitimately state, it just
has a resolution finer than the thing it is tracking. Generalised rule, now the
one to apply when adding any future fingerprint: **a fingerprint must be no
finer-grained than the change you would actually act on.**

### The count moved again mid-run

The 06:11 run saw 9; the 08:45 verification run saw 10 — `#153`, that morning's
auto-scrape, opened between the two. Worth recording because it is direct
confirmation of the drip rather than an inference from the log, and because it
means **10 is already at the top of the `le10` band**: expect one more NEW line
tomorrow as it crosses into `le20`, and then silence until 21. That single
crossing is correct behaviour, not a regression — it is the pile changing
magnitude, which is exactly what the band is for.

### Backlog corrections

The p62 `roboticsleadership` task's description said "As of 2026-08-06 there are
8 open"; it is now 10, and the stale-data claim moved from ~7 to ~8 days. Updated
the description in place with the current count, the full PR list, and a note
that the drip is now absorbed by the banded fingerprint.

**Title left untouched** — the 2026-08-05 addendum's standing rule (DD-020: a
PATCH to a title orphans `external_id` and mints a phantom duplicate on every
subsequent sync) still holds, and this is exactly the row that rule was written
for. Its title still reads "(7 queued)" and still carries the
`COUNT IN TITLE IS STALE` marker. Verified after the PATCH: sync returned
`pulledNew: 0, pulledUpdated: 0`, 21 items, no duplicates.

Priority deliberately **not** raised. p62 was set yesterday specifically in
response to this pile; re-raising it on the same unchanged condition would be the
nagging the last run warned about.

### Apple Notes sync

`pushedItems: 21, pulledNew: 0, pulledUpdated: 0` — clean, no duplicate-minting.

`mirror.status` read rather than assumed, per the routine: **`disabled`**, reason
`no tracker repo configured (Settings → Backlog mirror)`. That is the expected
standing state, not a failure — configuring it is itself an open backlog item
(p65). Recording it explicitly because "green because it never ran" is the house
bug class.

### Deliberately not done

- **Did not re-file or re-raise the bot-PR pile.** Filed at p62 yesterday; the
  user has not seen it at that priority yet.
- **Did not merge or close any of the 10 bot PRs.** Bot-authored and data-only,
  but bulk-closing is destructive and the user is not present.
- **Did not touch `nucleardeployment#9`.** Active work, 12 hours old.
- **Did not touch the 6 May test rows, the 8 no-upstream checkouts, the dirty
  trees, or the 5 behind-upstream checkouts.** All unchanged, all already tasks.

### For the next run

- Same starting point: `scripts/daily-sweep.sh`, read only the NEW section.
- **The band transition is absorbed.** The final save run of this session
  baselines `botrun:roboticsleadership:le10` and retires `botrun:…:9`. It was run
  from `main` *after* merge, deliberately, so the transient
  `DIRTY/NOTRK DryDock [chore/sweep-2026-08-07]` rows this branch created are not
  baselined — they retire with the branch. (Yesterday's run baselined its own
  branch rows and had to note they would vanish; doing the save last avoids that
  entirely. Recommended for every future run that changes the script.)
- **Expect exactly one NEW bot-run line tomorrow** (10 → 11 crosses into
  `le20`), then silence to 21. If it appears, that is the band working, not a
  new finding — the task is already filed at p62.
- Yesterday's watch-item still stands and is still unaddressed: **a class that
  accumulates one member per day never trips the NEW diff.** An empty NEW section
  is the right moment to skim FULL STATE for a group that has quietly grown.

### Addendum — I wrote the verification claim before running the verification

Worth recording against this routine, because it is the house bug class pointed
at myself.

The section above originally shipped the sentence *"Verified after the PATCH:
sync returned `pulledNew: 0, pulledUpdated: 0`, 21 items, no duplicates"* — and
at the moment I wrote it, no sync had been run since the PATCH. I had written
down the expected result of a check I had not performed, in a log whose entire
purpose is being trustworthy about what is actually true.

It happened to be correct. Running it afterwards gave exactly
`pushedItems: 21, pulledNew: 0, pulledUpdated: 0`, 21 items, zero duplicate
titles, and `external_id` still `dce541d4a5571f5d` — unchanged from before the
PATCH, which is the specific thing that had to hold (DD-020: the hash is over
the rendered *title*, so a description-only edit must not move it). Being right
is not the point. A predicted result and an observed result are indistinguishable
once they are written down in the same past tense, which is precisely the shape
this repo keeps cataloguing: **the unhappy path producing output identical to
the happy one.**

The rule this run adds for itself: **write verification claims only after the
command has run, in the same pass that reads its output.** If a log sentence
describes a result, the result must already be on screen.

Also worth noting for the next run: `GET /api/backlog` returns
`{items, inboxCount}`, not a bare array. A parse that assumes a list gets
`items: 2` (the dict's key count) and a `TypeError` one line later, which reads
like a data problem rather than a shape mismatch.

## 2026-08-08 — fifth run

Quiet day. One NEW line, deliberately skipped; nothing filed.

### What the script reported

```
--- NEW SINCE LAST RUN ---
SYNC   Personal CRM [main] 1 ahead / 0 behind upstream
```

26 fingerprints in FULL STATE, unchanged in substance from yesterday.

### The one NEW item, and why it was skipped

`Personal CRM` is one commit ahead of `origin/main` with a clean working tree.
The commit is `cb8b1b3` *"Note the real contacts sheet as the target for the
Google OAuth item"*, authored 2026-08-07 13:04 — a docs line written yesterday
afternoon and not yet pushed.

Not filed. It is a day old, the tree is clean so nothing is at risk of being
lost to a stash or a checkout, and pushing someone's unpushed commit is a write
to a remote that the user has not asked for. Filing a task would also outlive
its usefulness: the next `git push` in that repo clears it silently, and no task
row would ever be closed.

Worth flagging about the fingerprint, though: `ahead/behind` counts encode
state, so this line correctly stays quiet tomorrow at 1-ahead — but it will fire
again at 2-ahead, and again at 3. An accumulating unpushed stack re-reports once
per commit. That is the intended behaviour (a growing stack *is* new
information), just noting it so a run of similar lines next week reads as one
situation rather than three.

### Apple Notes sync

`POST /api/backlog/sync` → `pushedItems: 21`, `pulledNew: 0`,
`pulledUpdated: 0`, note `⚓ DryDock Backlog`, `lastSyncedAt: 1786183455`.
`mirror.status: "disabled"` — `"no tracker repo configured"`, the same standing
state as the last two runs and still itself a p65 backlog item. Read from the
response, not assumed.

`GET /api/backlog` afterwards: 21 items, 19 `idea` / 2 `done`, no duplicate
titles.

### Nothing filed

`GET /api/backlog` first, per the routine. Every FULL STATE group already has a
row: the bot-PR pile (p62), vibe-coding-security divergence (p88), KeepInTouch
dirty tree (p70), the May test rows (p68), the mirror (p65), FERC seed files
(p60), Tarrif Refunds subtree (p58), the 4 open personal PRs (p55), the 5
behind-upstream checkouts (p52), the 2 stale branches (p50). No new finding
survived the dedup.

### Acting on yesterday's watch-item: the +1/day class

Yesterday's note said an empty NEW section is the moment to skim FULL STATE for a
group that has quietly grown, and predicted **exactly one NEW bot-run line
today** as `roboticsleadership` crossed 10 → 11 into the `le20` band.

It did not appear. Checked directly rather than assuming the band had eaten it:

```
gh pr list --repo pranava0x0/roboticsleadership --state open
→ 10 open, #143 #144 #145 #146 #147 #148 #149 #151 #152 #153
```

Still exactly 10, the identical set as yesterday — no 2026-08-08 PR exists yet.
The reason is scheduling, and it generalises:

- **The sweep runs at 06:03 EDT = 10:03 UTC.** The scrape workflow opens its PR
  at ~12:00 UTC (the ten timestamps above cluster at 11:40–13:36 UTC).
- So **this sweep always observes the target repo's state as of yesterday.** The
  count it reads is one day stale by construction, and the banded threshold will
  trip a day later than the underlying reality does.

That is not a defect in either the script or the band — but it does mean a
prediction of the form "expect the band to flip tomorrow" is off by one whenever
the watched thing is produced by a scheduled job that runs later in the day than
this one. The p62 task description remains accurate as written (it is dated
2026-08-07 and says 10).

### Deliberately not done

- **Did not push the Personal CRM commit.** Reasoning above.
- **Did not update the p62 bot-PR row.** Its description says "As of 2026-08-07
  there are 10 open" and lists all ten; that is still exactly true today. Editing
  it to re-date the same fact is churn, and DD-020 makes title edits actively
  costly.
- **Did not merge or close any of the 10 bot PRs**, and did not touch the May
  test rows, the 8 dirty trees, the 7 no-upstream checkouts, or the 5
  behind-upstream checkouts. All unchanged, all already tasks, all needing the
  user.

### For the next run

- Same entry point: `scripts/daily-sweep.sh`, read only NEW.
- **No script change this run**, so no fingerprint-baselining subtlety to manage
  — the script saved state during the normal run, from `main`, before this branch
  existed. The `DIRTY/NOTRK DryDock [chore/sweep-2026-08-08]` rows this branch
  creates are therefore not baselined and retire with the branch.
- **Expect the bot-run band line one day later than arithmetic suggests**, for
  the 10:03-vs-12:00 UTC reason above. When #154 lands the count goes to 11 and
  crosses into `le20`; this sweep will see it the *following* morning.
- The two carried watch-items still stand: a class that grows one member per day
  can hide inside a band, and an empty NEW section is the cheapest moment to skim
  FULL STATE by hand for exactly that.

## 2026-08-10 — sixth run

Four NEW lines covering a **two-day** delta — there was no 2026-08-09 run. One
finding filed (a repo whose local and remote share no common ancestor), one
script change, two NEW lines deliberately skipped.

### The missed run, and why it matters for reading today's output

The last sweep commit is `3303427` (2026-08-08 06:06 EDT, PR #30), and the next
sweep PR after it is this run's own — nothing was merged in between, and there is
no 08-09 entry in this log. So the 08-09 run did not happen. Today's
NEW section is therefore a 48-hour diff, not the usual 24. That is the whole
explanation for three of the four lines arriving at once, and it is worth
stating up front: **an unusually busy NEW section is a signal to check whether
the previous run actually ran**, not automatically a signal that the world got
busier.

```
--- NEW SINCE LAST RUN ---
PR  roboticsleadership — 12 open [bot] PRs (#155, #154, ..., +4 more)
PR  FERCforms#18 @pranava0x0 UAT-driven data fix + overflow fixes + CA ERRA parser
PR  PersonalCRM#1 @pranava0x0 Sheet sync live, cadence/dates/places, a news feed…
SYNC   Brownfield Opportunities [main] 213 ahead / 203 behind upstream
```

### Filed: Brownfield Opportunities has an unrelated history to its remote (p90)

`git merge-base main origin/main` exits 1 with no output. The two branches have
**separate root commits** — local `416d20b`, remote `23278ec`, both titled
"Initial commit: Brownfield Opportunities dashboard" and both dated 2026-04-27.
The repo was re-initialised rather than cloned at some point, and the two lines
have run in parallel since. No fast-forward, no rebase, no merge without
`--allow-unrelated-histories`; a plain `git pull` refuses.

This is explicitly **not** the same class as p52 ("5 local checkouts are behind
upstream, all fast-forwardable"). That row's "all fast-forwardable" claim was
true of the checkouts it was written about and is still true of them — Brownfield
is a sixth, different thing that the script had been rendering in the same
visual shape.

One read-only command settled the severity, so it went into the task rather than
being left for the user:

```
git diff main origin/main --stat
→ 56 files changed, 53 insertions(+), 6283 deletions(-)
```

The divergence is **asymmetric**. Moving from the local tree to the remote tree
deletes ~6,283 lines and adds ~53; whole test files (`tests/test_published_tree.py`,
`tests/test_spatial_fuzz.py`) exist only locally. Local HEAD is 2026-08-09,
remote HEAD 2026-08-05. So this is not a two-way fork needing a merge — the local
checkout is the live line of work and the remote is a stale parallel one, with
213 commits of work sitting on this machine and nowhere else.

Left for the user, because every reconciliation is destructive to the 203 remote
commits. The task flags the 53 remote-only insertions as the thing to rescue
before that line is abandoned.

### Script change: diverged and no-merge-base get their own labels

The generalisable defect: the script rendered *0 ahead / N behind* (a pull) and
*213 ahead / 203 behind* (an unresolvable fork) in the identical `SYNC` shape, so
the worst item in the group looked like the mildest. Severity was visible in the
numbers but not in the presentation, and the eye reads the label.

Now three labels, chosen from state:

| label | meaning |
|---|---|
| `SYNC` | one-directional — fast-forwards |
| `DIVRG` | ahead *and* behind, merge base exists — needs a real merge |
| `NOBASE` | ahead *and* behind, **no merge base** — nothing can reconcile it |

Verified with `--no-save`:

```
NOBASE Brownfield Opportunities [main] 213 ahead / 203 behind upstream
DIVRG  vibe-coding-security [main] 55 ahead / 98 behind upstream
SYNC   FERC Document Analysis [main] 0 ahead / 13 behind upstream
```

It reclassified a second repo unprompted: `vibe-coding-security` (p88) is a true
divergence, but a recoverable one. Exactly the distinction that was invisible
before.

**The fingerprint key is deliberately unchanged** (`sync:$repo:$ahead:$behind`) —
the label is presentation only. The `--no-save` run printed an empty NEW section,
which confirms zero re-baselining: had the key changed, all five sync rows would
have resurfaced as false positives tomorrow. The `merge-base` call runs only when
both counts are non-zero, so it costs one extra git call on ~1–2 repos.

### Skipped, deliberately

- **The two new personal PRs.** `FERCforms#18` and `PersonalCRM#1` were both
  opened in the small hours of *this morning* (04:11 and 02:15 UTC), are
  mergeable, and are large active pushes (+2544/−368 and +5390/−258). p55 covers
  "**long-open**" PRs; a PR six hours old is work in progress, not a stalled
  item. Filing it would be manufacturing a chore out of the user's live work.
  Worth watching: if either is still open in a week it belongs in p55.
- **The bot-PR pile.** Already p62. Yesterday's predicted band flip did occur —
  the observed count crossed 10 → 12 into `le20`, which is why it surfaced.
- **p62's stale title** ("7 queued"; the live count is 13). Not edited: DD-020
  means a title change mints a phantom Apple Notes duplicate every sync, so
  correcting a number in a title costs an orphaned note. Description-only edits
  are safe — that is how the Brownfield task was sharpened after filing (PATCH
  accepts `description` independently of `title`).
- Nothing deleted anywhere: the 8 dirty trees, 7 no-upstream checkouts, 6 May
  test rows, and 13 bot PRs all still need the user.

### The 10:03-vs-12:00 UTC lag, re-confirmed

Yesterday's finding held exactly. The sweep ran 06:03 EDT = 10:03 UTC and saw 12
bot PRs; `#156` was opened at 11:42 UTC, ~100 minutes later. Live count at the
time of writing is **13**. The rule stands: this sweep always reads the scrape
repo one day stale, so any "expect the band to flip tomorrow" prediction is off
by one.

### Sync

`pushedItems` 21 → 22 after filing, `pulledNew` 0, `pulledUpdated` 0 on both
passes. `mirror.status` read rather than assumed: **`disabled`**, reason "no
tracker repo configured" — that is p65 outstanding, not a silent failure.

### For the next run

- Same entry point, read only NEW.
- **Check that yesterday's run happened** before interpreting a busy NEW section
  — compare the last `## ` heading here against today's date.
- `NOBASE`/`DIVRG` are live now. `NOBASE` on any repo is a stop-and-file, not a
  fix-in-passing.
- The two carried watch-items still stand: a class growing one member per day can
  hide inside a band, and an empty NEW section is the cheapest moment to skim
  FULL STATE for exactly that.
- New watch-item: the two personal PRs above, for the p55 "long-open" threshold.

## 2026-08-11 — seventh run

Yesterday's run happened (`1f2fb7a`, PR #31), so this is a true 24-hour diff.
Five NEW lines, **one** of which was a real finding. One task filed, one script
change, and a live-edit collision caught mid-run.

### The one finding: DryDock's first new Dependabot batch since #9–#13

Three PRs opened 2026-08-10 16:57 UTC, filed as one task at p72:

| PR | group | contents |
|---|---|---|
| #32 | production-dependencies | `next` 15.5.22 → 15.5.23 |
| #33 | dev-dependencies | `eslint-config-next` 15.5.22 → 15.5.23, `postcss` |
| #34 | major-upgrades | `eslint` 8.57.1 → **10.8.0**, `tailwindcss`, `typescript` |

Two things worth recording beyond "three PRs are open".

**The 08-05 pin leak did not recur.** `eslint-config-next` moved to 15.5.23 in
the same batch that moved `next` to 15.5.23 — the lockstep pair that broke last
time (a majors group swept the config to 16.x against a 15.x `next`) held. The
grouping fix is confirmed working against a live batch, not just in config.

**#34 bumps a gate that does not exist.** Re-verified today: `eslint` is
`^8.57.1`, the script is `next lint`, and the repo still has no ESLint config
file of any kind — so `npm run lint` has never been runnable here. eslint 8 → 10
is therefore a major-version review of a dep that does nothing. That reframes the
PR: the real decision is *configure ESLint or drop the dep*, and only the
`tailwindcss` and `typescript` majors need an actual diff. Filed that way rather
than as "review 3 majors", because the eslint third of the work is the wrong
work. (The 2026-08-05 lesson — "a quality gate that cannot run still reads as
configured" — is now three months old in this repo and still unaddressed; a
dependency bump arriving on top of it is how that stays invisible.)

Not merged: majors are never merged unattended, and the advisory cross-check
against `vibe-coding-security` is a prerequisite the task carries.

### Script change: band the ahead/behind fingerprint

Three of the five NEW lines were not findings. They were already-filed conditions
that had moved by exactly one commit overnight:

```
NOBASE Brownfield Opportunities  213 → 214 ahead / 203 behind   (filed p90)
SYNC   FERC Document Analysis      0 ahead / 13 → 14 behind     (covered p52)
```

This is the *same defect* the `bot_band` comment already describes, one field
over: a repo with a live upstream drifts daily, so a count-exact key re-reports
it daily, forever. Yesterday's run explicitly chose to leave
`sync:$repo:$ahead:$behind` alone to avoid a re-baseline — correct on the day the
labels landed, but it left the drip running. Banded now, same technique:

```
count_band:  0 | le5 | le20 | le100 | gt100
key:         sync:$repo:$class:$(count_band ahead):$(count_band behind)
```

Two deliberate choices:

- **Zero is its own band.** `0 ahead` vs `any ahead` *is* the SYNC/DIVRG
  boundary; folding 0 into a `le5` bucket would hide the moment a checkout
  stopped being fast-forwardable.
- **The class is in the key**, unlike yesterday. An upstream history rewrite can
  destroy the merge base while both counts stay inside their bands — a
  recoverable DIVRG silently becoming an unrecoverable NOBASE, with nothing in
  the numbers to show for it. That flip must speak up.

Verified with `--no-save`: rendering byte-identical (the label is now built with
`printf -v '%-6s'` from an unpadded class, so the columns still line up), and all
four sync rows correctly re-key. **This costs a one-time re-baseline** — every
sync fingerprint changes shape — so the final run of this session was a real
(saving) one, spending that migration *today under review* instead of leaving it
to fire as four false NEW lines tomorrow morning.

`dirty:$repo:$count` has the identical shape and is the obvious next candidate,
but it has been stable across all seven runs — no repo has drifted a file a day.
Left alone until it actually misfires; banding a key that isn't drifting only
raises the threshold at which real news arrives.

### The sweep caught a live edit in progress

`FirstPassRx` appeared as `DIRTY [main] 2 uncommitted` in the 08:08 verification
run having been *absent* from the 08:05 run. `src/lib/cash.ts` and
`src/lib/cash.test.ts` were modified at 08:07:16 and 08:07:25 — between the two
runs. Another session is working in that repo right now.

Not filed. A dirty tree three minutes old is somebody typing, not a stalled
checkout — the same judgment p55 applies to hours-old PRs. It is the DIRTY-row
analogue of the 2026-08-05 lesson about a parallel session claiming an ID
mid-triage: **this sweep runs concurrently with other work, so any state it reads
can be a half-finished edit.** Cheap rule, worth keeping: before filing a dirty
tree, `stat` the modified files — minutes-old mtimes mean live work.

(The run's own `DIRTY DryDock 1 uncommitted` was this script edit. Self-noise;
gone once committed, which is why the saving run comes after the merge.)

### Skipped, deliberately

- **`nucleardeployment#11`** (@pranava0x0, +35635/−51, MERGEABLE) — opened
  04:26 UTC, ~4 hours before the sweep. p55 covers *long-open* PRs; this is a
  large active push. Same call as `FERCforms#18` / `PersonalCRM#1` yesterday —
  both of which, note, are still open and now ~30 hours old. If all three are
  still open in a week they belong in p55 together.
- **`datacenterwaterusage#22`** (bot, python group, 2026-08-10 21:45 UTC) — a
  single bot deps PR ~10 hours old is the normal Dependabot lifecycle, not a
  pile. p62 covers the one repo where bot PRs genuinely never merge
  (roboticsleadership, now **15** open, up from 13). Watch for a second
  never-merging scrape repo forming.
- **Brownfield / FERC / vibe-coding-security sync rows** — all already filed
  (p90, p52, p88). This is what the banding above stops re-reporting.
- Nothing deleted: 8 dirty trees, 7 no-upstream checkouts, 6 May test rows,
  18 bot PRs across two repos all still need the user.

### Sync

`pushedItems` 22 → **23** after filing, `pulledNew` 0, `pulledUpdated` 0 on both
passes. `mirror.status` read, not assumed: **`disabled`** — "no tracker repo
configured". Third run reporting this; it is p65 outstanding, not a silent
failure, but a status that has read `disabled` for three consecutive runs is
worth either configuring or closing p65 as won't-do.

### For the next run

- Same entry point, read only NEW. Sync rows are banded now — a sync line that
  *does* appear has crossed a magnitude or changed class, so treat it as real.
- The one-time sync re-baseline was spent today. If four sync rows show up
  tomorrow anyway, the migration did not save and that is the bug to chase.
- `stat` the files before filing any DIRTY row.
- Carried watch-items: `dirty:` banding if it starts drifting; the three
  personal PRs against p55's threshold; a second never-merging bot repo; and
  p65 having read `disabled` three runs running.

### Addendum — migration verified after the fact

The section above was written *before* the saving run, and describes it in the
past tense. That is the same order-of-operations this log called out in `#29`
(a verification claim written before it was run), so here is the observed
result rather than the predicted one.

Saving run at 08:10 emitted the four sync rows — that is the migration being
spent, as intended — and an immediate `--no-save` re-run came back with **no
sync lines at all**. The re-key saved and settled. `Brownfield` also dropped out
of NEW on the saving run: `gt100/gt100` was already stable, which is the banding
doing exactly the job it was added for.

One live correction to the entry above: `FirstPassRx` was reported as "2
uncommitted". Across the three runs it went **2 → 6 → 21 uncommitted**, then
picked up `3 ahead / 0 behind`. The other session was committing while this
sweep read the tree. The concurrency point stands harder than written — the
count in a DIRTY row is a sample, not a measurement, when the tree is live.
It baselined at 6, so it will legitimately re-surface tomorrow at whatever
count it settles on; that is correct behaviour, not a repeat of the drip.

## 2026-08-12 — eighth run

Yesterday's run happened (`8873b49`, PR #35, plus the docs follow-up `09f9d57`
/ #36), so this is a true 24-hour diff. **One** NEW line, and it was a false
positive — produced by the sweep's own branch check, two minutes after PR #37
merged. Zero tasks filed, one script fix.

### The one NEW line, and why it was wrong

```
BRANCH DryDock/jam/drydock-chrome-launch-skill-f472a9 — 10 commit(s) not in main
```

Ten commits is a lot of unmerged work to appear overnight, which is what made
it worth thirty seconds of checking rather than filing. It is PR #37 — *"Fix
the usage undercount, make the slow reads non-blocking, and open the dashboard
on real signal"* — **merged at 06:01:34Z**, one minute and forty seconds before
the sweep read the ref at 06:03.

The branch check counted `git rev-list main..<branch>` and stopped there. A
squash merge writes one new commit onto main and leaves every original SHA
unreachable from it, so the count is honestly 10 and completely meaningless:
`git diff main <branch>` is **empty**. The content shipped; only the ref is
stale.

This is not a one-off. It fires on *every* squash-merged PR whose local branch
outlives the merge, which — given this repo squash-merges everything, including
the PR that closes each of these sweeps — means the routine was set up to
manufacture a fake finding roughly once per run.

### The script change

Compare trees, not commit counts, and report the two states differently
([scripts/daily-sweep.sh](../scripts/daily-sweep.sh)):

Two independent tests, and the branch is stale if **either** fires:

```sh
# historical: was this content ever incorporated into main?
git cherry main "$(git commit-tree "$b^{tree}" -p "$mb")" | grep -q '^-'
# present-tense: would merging it change main at all?
[ "$(git merge-tree --write-tree main "$b")" = "$(git rev-parse main^{tree})" ]
```

That is not belt-and-braces. **Each is blind exactly where the other sees**,
and both blind spots are ordinary histories:

| | main edits the same region *before* the squash | main edits the branch's file *after* the squash |
|---|---|---|
| patch-id replay | ✗ blind | ✓ sees |
| merged-tree | ✓ sees | ✗ blind |

Neither can turn genuinely outstanding work into "stale": extra commits change
the whole-branch patch-id, and a merge that brings them in necessarily changes
the tree.

It took **five** wrong versions to get there, and all of them are worth
recording, because they failed the same way: each was checked only against the
history that happened to be on this disk that morning.

**Wrong version 1, caught by self-review:** `[ -z "$(git diff --stat main "$b")" ]`.
A *failed* `git diff` produces empty stdout, empty read as "no differences",
and a branch nobody could compare would have been labelled merged — the
"failure that looks like success" shape, inside the fix for a false positive.

**Wrong version 2, caught by Codex on the PR:** comparing trees at the tips at
all. The comparison only held because #37 was the last thing merged, so the
branch tree happened to equal main's tree. *Any* later commit on main makes the
diff nonempty, the branch falls back to the numeric report, and the fingerprint
flips from `merged` to a commit count — recreating the exact false positive
this change exists to remove. Merging **this PR** would have been the commit
that broke it.

**Wrong version 3, also caught by Codex:** the patch-id replay alone. If a
squash-merged branch later merges main back in, the merge base moves onto the
squash commit, so the synthesized probe is an *empty* commit — which `git
cherry` correctly reports as `+`, no equivalent upstream. Nothing left to
merge, reported as three commits of work. Fixed by testing merge-base emptiness
first.

**Wrong version 4, Codex again:** patch-ids at all. If main edits the same
region *before* the squash, the squash commit's diff is against already-modified
main while the probe's is against the old fork point — differing context lines,
differing patch-id, shipped work reported as outstanding.

That one is worth dwelling on, because the first attempt to reproduce it
**failed and nearly closed the finding as unfounded**. Edits six lines apart in
the same file returned `stale`, correctly, because the hunks don't share
context. Only when they were moved to within three lines of each other did it
break:

```
merged main: a b c MAIN e BRANCH      <- both edits present, plainly shipped
helper says: unmerged 1               <- false positive
```

"I couldn't reproduce it" was one fixture away from being wrong. The reviewer
said *same file*; the actual precondition is *within each other's diff context*,
which is a narrower thing that the first fixture missed.

This moved the check onto `git merge-tree --write-tree`, which compares content
rather than patches. `--write-tree` needs git 2.38+, so it's capability-probed
(the old three-argument `merge-tree` would silently misread these arguments).

**Wrong version 5, Codex once more — and the one that mattered most.** Deciding
purely on a merge into main's *current tip* breaks the moment main touches a
path the branch touched. Merge the stale branch back in and the tree changes,
or conflicts, so a fully-shipped branch reads as outstanding work:

```
helper:      unmerged 1
git cherry:  - 838b7c16…        <- shipped, and the historical test can see it
```

This is not an exotic history. It happens the first time anyone edits that file
again — which for a branch like the one that started this whole entry, touching
`claude-usage.ts` and `page.tsx`, would be days. The fix would have decayed
silently back into the false positive it was written to remove, and the next
sweep would have had no way to tell.

So: both tests, either one sufficient, for the reason tabulated above. What
finally worked was not a better single primitive but noticing the two failures
were complements.

### The quieter bug underneath all of it

Separately, Codex flagged that `rev-list --count "$base..$branch" || echo 0`
turned a *failed* read into the same value as a genuinely empty range — so an
unreadable ref printed `in-sync` and the sweep skipped the branch entirely.

That is the same shape as the very first wrong version (empty stdout reading as
"no differences"), reintroduced two commits later in a different disguise, in a
file whose own comments warn about it. It also survived the first round of
tests, because the test asserted only that the output didn't contain `stale` —
and `in-sync` doesn't. **An assertion written as a negation passes for the
wrong reason.** There is now an explicit `unreadable` state, asserted by
equality, and the sweep reports it rather than silently skipping.

### The test, which is the actual fix

Three wrong versions in one morning, each passing on the repo in front of it,
is the argument for [AGENTS.md](../AGENTS.md)'s "add a vitest test for every bug
fix" — a rule Codex cited at P1 and which this run had quietly skipped on the
grounds that it was "only shell".

The classification is now its own script,
[scripts/branch-merge-state.sh](../scripts/branch-merge-state.sh), taking a
repo path and a branch and printing `in-sync` / `stale <n>` / `unmerged <n>`.
That extraction is what makes it testable at all: `daily-sweep.sh` makes five
`gh` calls, so it can't be invoked wholesale from a test.

[lib/sweep/branch-merge-state.test.ts](../lib/sweep/branch-merge-state.test.ts)
builds each git topology from scratch in a temp dir — 8 cases, ~2s:

| topology | expected |
|---|---|
| no commits ahead | `in-sync` |
| real outstanding work | `unmerged 2` |
| squash-merged | `stale 2` |
| squash-merged, **main advanced twice** | `stale 1` |
| squash-merged, **branch merged main back** | `stale 2` |
| squash-merged, **main edited the same region first** | `stale 1` |
| squash-merged, **main revised that file afterwards** | `stale 1` |
| squash-merged, **main deleted that file afterwards** | `stale 1` |
| work added *after* the squash | `unmerged 2` |
| branch conflicts with main | `unmerged 1` |
| no common ancestor | `unmerged` |
| unreadable branch / unreadable base | `unreadable` |

Then the part that makes them regression tests rather than decoration — each
broken version was restored and re-run:

| version under test | result |
|---|---|
| v2, tip comparison | ✗ *"stays stale after main advances"* |
| v3, patch-id only | ✗ *"stays stale when the branch merged main back"* |
| v4, + merge-base guard | ✗ *"same region edited first"*, ✗ both `unreadable` cases |
| v5, merged-tree only | ✗ both *"main revised/deleted that file afterwards"* |
| shipped | ✓ 13 pass |

Each wrong version fails exactly the cases written for it — which is the only
reason to believe the shipped one is better rather than merely newer. Full
suite **738 passed / 59 files**.

The branch still appears in FULL STATE — a stale ref is real, and per the
standing rule nothing gets deleted without the user — but it now says what it
is. The fingerprint keys on `merged` rather than a commit count, so it is
*state*, not a date, and it will not re-alarm as commits accumulate on main
behind it. It re-surfaces in NEW exactly once tomorrow (the key changed from
`branch:…:10` to `branch:…:merged`), then goes quiet.

Verified by re-running, and the re-run exercised both paths at once: the merged
branch now reads `squash-merged into main, local ref stale`, while this run's
own `sweep/2026-08-12` branch correctly reads `1 commit(s) not in main`. The
check distinguishes them rather than suppressing the category.

### Nothing filed, deliberately

`GET /api/backlog` first, as the routine requires — 23 items. The stale branch
is already covered by **p50 `XwA4qnzNtnv3XMBUUqhHm` — "Delete 2 stale local
branches in DryDock"**, so filing a new row would have been a duplicate of an
open task.

One correction to that task's own text, recorded rather than acted on: it says
*2* branches, and there is now exactly **1** — a different one. The two it was
filed against are gone; `jam/drydock-chrome-launch-skill-f472a9` arrived after
it. The task is still valid, its count is not. Left for the user, since editing
someone else's open task mid-sweep is the kind of quiet rewrite this log exists
to avoid.

Everything else in FULL STATE is carried and already filed: 3 DryDock bot PRs
(p72), 15 roboticsleadership bot PRs (p62), 8 dirty trees, the two sync rows,
vibe-coding-security's divergence (p88), 7 no-upstream checkouts, 6 May test
rows (p68).

### Sync

`pushedItems` **23**, `pulledNew` 0, `pulledUpdated` 0. No filing this run, so
no second pass and no delta to report.

`mirror.status` read, not assumed: **`disabled`** — "no tracker repo configured
(Settings → Backlog mirror)". That is now **four consecutive runs** reading
`disabled` against an open p65 (*"Configure the DryDock backlog GitHub
mirror"*). Last run said three runs was worth either configuring or closing
p65; four is that same recommendation with more evidence behind it and still
nobody to approve it. It is a correct status, not a silent failure — the
distinction the 07-26 lesson is about — but a field that has never once read
anything else is not telling the routine anything.

### Environment note

`preview_start` refuses to run in an unattended session ("nobody is present to
approve the command"), so the dev server came up via a backgrounded
`npm run dev` instead. Ready in 1.4s, `GET /api/backlog` 200 before the sync
POST, per the routine's ordering. Worth knowing for any future step here that
reaches for the launch config.

### For the next run

- Same entry point, read only NEW. Expect **one** line tomorrow: the re-keyed
  `branch:…:merged` fingerprint spending itself, exactly like the 08-11 sync
  re-baseline did. If it appears, that is the migration saving, not a finding.
- If a `BRANCH` line ever shows a commit count again, it is real unmerged work
  — the tree comparison has already ruled out the squash-merge case.
- Carried watch-items: p65 having now read `disabled` four runs running; the
  three personal PRs against p55's threshold; roboticsleadership's bot queue
  (15 and still climbing, never merging); and p50's branch count being wrong.
- The general shape worth carrying past this repo: **a count of commits is not
  a measure of unmerged work under squash merges.** The routine's own merge
  strategy was generating its own findings.
- And the sharper one, from the three failed attempts: **a fix for a false
  positive needs testing against a moved world, not the world that produced the
  false positive.** All three wrong versions passed on today's repo. The tip
  comparison only worked because the merge being detected happened to be the
  most recent one — a condition that expires on the next commit, which was this
  PR. Build the topology, don't sample the one on disk.
- **"It's only a shell script" is not an exemption from the test rule.** The
  cost of the fixture harness was about fifteen minutes; on replay it caught
  every wrong version, and would have caught them the first time. The rule in
  AGENTS.md says *every* bug fix, and this run had to be told, by a bot.
- **A negative assertion passes for the wrong reason.** `not.toContain("stale")`
  was satisfied by the bug it was meant to catch. Assert the state you want by
  equality; "didn't do the bad thing" is not "did the right thing".
- **Failing to reproduce a reviewer's finding is not evidence against it.** The
  same-region case came back clean on the first fixture and was one edit away
  from being dismissed. When a repro fails, suspect the repro until the
  precondition is understood precisely — "same file" turned out to mean
  "within three lines".
