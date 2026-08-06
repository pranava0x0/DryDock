#!/usr/bin/env bash
# Daily cross-project sweep for the drydock-daily scheduled task.
#
# Answers, in one pass and without an agent: what work is open on GitHub, what
# is sitting uncommitted or diverged in a local checkout, and — crucially —
# which of that is NEW since the last run. The "new" part is the whole point:
# without it every run re-reads the same stale Dependabot PRs and the agent
# burns tokens restating them.
#
# State lives in ~/.drydock/sweep-state.txt (one fingerprint per line). The
# script prints two sections: NEW SINCE LAST RUN (act on these) and FULL STATE
# (context). Run with --full to skip the diff and print everything as new.
#
# Usage:  scripts/daily-sweep.sh [--full] [--no-save]
set -uo pipefail

# Piping this into `head` (or quitting `less` early) closes stdout, and the
# next echo would kill the script on SIGPIPE — *before* it reaches the state
# save at the bottom. The run then looks like it completed while silently
# leaving the fingerprints unadvanced, so the next run re-reports everything
# as NEW. Ignoring SIGPIPE lets the writes fail harmlessly and the save still
# happen. (`set -e` is deliberately not enabled, so a failed echo won't abort.)
trap '' PIPE

GH_OWNER="${GH_OWNER:-pranava0x0}"
PROJECTS_ROOT="${PROJECTS_ROOT:-$HOME/Projects}"
STATE_DIR="${DRYDOCK_STATE_DIR:-$HOME/.drydock}"
STATE_FILE="$STATE_DIR/sweep-state.txt"

FULL=0
SAVE=1
for arg in "$@"; do
  case "$arg" in
    --full) FULL=1 ;;
    --no-save) SAVE=0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

mkdir -p "$STATE_DIR"
[ -f "$STATE_FILE" ] || : > "$STATE_FILE"

CURRENT="$(mktemp)"
BOTPRS="$(mktemp)"
trap 'rm -f "$CURRENT" "$BOTPRS"' EXIT

# emit <fingerprint> <human-readable line>
# The fingerprint is what gets diffed run-to-run, so it must change only when
# the *situation* changes — never embed today's date in it.
emit() { printf '%s\t%s\n' "$1" "$2" >> "$CURRENT"; }

echo "=== DryDock daily sweep — $(date '+%Y-%m-%d %H:%M') ==="
echo

# ---------------------------------------------------------------- GitHub ----
# A failed `gh` call and a genuinely empty result both produce zero lines, so
# exit status is checked explicitly and a failure degrades the whole run to
# partial. Without that, an expired token would look exactly like "no open
# issues today" — and worse, the empty result would be saved as the new
# baseline, making every PR report as NEW on the next working run.
DEGRADED=0

gh_search() { # <subcommand> <jq> -> stdout, nonzero on failure
  local sub="$1" jq="$2" err
  err="$(mktemp)"
  if ! gh search "$sub" --owner "$GH_OWNER" --state open --limit 60 \
        --json repository,number,title,author --jq "$jq" 2>"$err"; then
    echo "!! gh search $sub failed: $(tr '\n' ' ' < "$err")" >&2
    rm -f "$err"; return 1
  fi
  rm -f "$err"; return 0
}

BOT_RUN_MIN=3   # this many open bot PRs in one repo collapses them to a run

if command -v gh >/dev/null 2>&1; then
  # Bot PRs are tagged inline rather than dropped, so a daily auto-scrape repo
  # can be skimmed past instead of re-triaged, without hiding it entirely.
  # They're buffered rather than emitted, because a repo with a daily scraper
  # produces one NEW line per day for what is really one standing condition
  # ("nothing merges these"). See the run-collapsing pass below.
  if prs="$(gh_search prs '.[]|"\(.repository.name)\t\(.number)\t\(.author.login)\t\(.title)"')"; then
    while IFS=$'\t' read -r repo num author title; do
      [ -n "${repo:-}" ] || continue
      case "$author" in
        *"[bot]") printf '%s\t%s\t%s\n' "$repo" "$num" "$title" >> "$BOTPRS" ;;
        *)        emit "pr:$repo#$num" "PR  $repo#$num @$author $title" ;;
      esac
    done <<< "$prs"

    # Collapse each repo's bot PRs into one line once there are BOT_RUN_MIN+ of
    # them. The fingerprint carries the *count*, so the run reports as NEW only
    # when the pile actually grows or shrinks — a one-in-one-out day (an old PR
    # merges, a new one opens) is not a change in the situation and correctly
    # stays quiet. Below the threshold each PR still gets its own line, so a
    # lone Dependabot bump is never hidden.
    if [ -s "$BOTPRS" ]; then
      while read -r botrepo; do
        [ -n "${botrepo:-}" ] || continue
        count="$(awk -F'\t' -v r="$botrepo" '$1==r' "$BOTPRS" | wc -l | tr -d ' ')"
        if [ "$count" -ge "$BOT_RUN_MIN" ]; then
          # Cap the enumerated numbers: `gh search --limit 60` means this could
          # otherwise render a 60-number line, which is the noise this pass
          # exists to remove. The count is the signal; the numbers are a hint
          # for finding them.
          nums="$(awk -F'\t' -v r="$botrepo" '$1==r {printf "#%s ", $2}' "$BOTPRS" \
                  | cut -d' ' -f1-8 | sed 's/ $//; s/ /, /g')"
          if [ "$count" -gt 8 ]; then nums="$nums, +$((count - 8)) more"; fi
          # Deliberately "open", not "none merged" — the script checks open PRs
          # and has not looked at merge history, so it must not claim to have.
          emit "botrun:$botrepo:$count" \
               "PR  $botrepo — $count open [bot] PRs ($nums)"
        else
          awk -F'\t' -v r="$botrepo" '$1==r {print $2"\t"$3}' "$BOTPRS" \
          | while IFS=$'\t' read -r num title; do
              emit "pr:$botrepo#$num" "PR  $botrepo#$num [bot] $title"
            done
        fi
      done < <(cut -f1 "$BOTPRS" | sort -u)
    fi
  else
    DEGRADED=1
  fi

  if issues="$(gh_search issues '.[]|"\(.repository.name)\t\(.number)\t\(.title)"')"; then
    while IFS=$'\t' read -r repo num title; do
      [ -n "${repo:-}" ] || continue
      emit "issue:$repo#$num" "ISS $repo#$num $title"
    done <<< "$issues"
  else
    DEGRADED=1
  fi
else
  echo "!! gh not on PATH — skipping the GitHub half of the sweep" >&2
  DEGRADED=1
fi

# ----------------------------------------------------------------- local ----
# Fingerprints carry the dirty-file count and the ahead/behind numbers, so a
# checkout that gets worse (or better) resurfaces while a static one stays quiet.
for dir in "$PROJECTS_ROOT"/*/; do
  repo="$(basename "$dir")"
  [ -d "$dir/.git" ] || continue

  dirty=$(git -C "$dir" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  branch=$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null)

  ahead=0; behind=0; tracked=1
  if git -C "$dir" rev-parse --abbrev-ref '@{u}' >/dev/null 2>&1; then
    read -r behind ahead < <(git -C "$dir" rev-list --left-right --count '@{u}...HEAD' 2>/dev/null)
  else
    tracked=0
  fi

  if [ "$dirty" != "0" ]; then
    emit "dirty:$repo:$dirty" "DIRTY  $repo [$branch] $dirty uncommitted"
  fi
  if [ "${ahead:-0}" != "0" ] || [ "${behind:-0}" != "0" ]; then
    emit "sync:$repo:$ahead:$behind" "SYNC   $repo [$branch] ${ahead} ahead / ${behind} behind upstream"
  fi
  if [ "$tracked" = "0" ]; then
    emit "notrack:$repo" "NOTRK  $repo [$branch] no upstream configured"
  fi
done

# DryDock's own unmerged branches — the repo this routine lives in gets a
# closer look than the rest.
if [ -d "$PROJECTS_ROOT/DryDock/.git" ]; then
  git -C "$PROJECTS_ROOT/DryDock" fetch origin --prune -q 2>/dev/null
  git -C "$PROJECTS_ROOT/DryDock" for-each-ref --format='%(refname:short)' refs/heads |
  while read -r b; do
    [ "$b" = "main" ] && continue
    n=$(git -C "$PROJECTS_ROOT/DryDock" rev-list --count "main..$b" 2>/dev/null || echo 0)
    [ "$n" = "0" ] && continue
    emit "branch:$b:$n" "BRANCH DryDock/$b — $n commit(s) not in main"
  done
fi

# ------------------------------------------------------------------ diff ----
sort -o "$CURRENT" "$CURRENT"

echo "--- NEW SINCE LAST RUN ---"
if [ "$FULL" = "1" ]; then
  cut -f2 "$CURRENT"
else
  # Compare fingerprints only; print the human line for fingerprints not seen before.
  join -v1 -t$'\t' -j1 \
    <(cut -f1 "$CURRENT" | sort -u) <(sort -u "$STATE_FILE") 2>/dev/null |
  while read -r fp; do
    grep -m1 -F "$(printf '%s\t' "$fp")" "$CURRENT" | cut -f2
  done
fi
echo

echo "--- FULL STATE ($(wc -l < "$CURRENT" | tr -d ' ') items) ---"
# NOTRK (no upstream) is the permanent resting state of every local-only
# project, so listing all of them every day is pure noise. Collapse to a count
# here; the fingerprints are still tracked, so a repo that newly gains or loses
# an upstream still shows up by name in the NEW section above.
if [ "$FULL" = "1" ]; then
  cut -f2 "$CURRENT"
else
  cut -f2 "$CURRENT" | grep -v '^NOTRK ' || true
  notrk=$(grep -c '^notrack:' "$CURRENT" || true)
  if [ "${notrk:-0}" -gt 0 ]; then
    echo "NOTRK  ${notrk} local-only checkout(s) with no upstream (collapsed; --full lists them)"
  fi
fi

echo
if [ "$DEGRADED" = "1" ]; then
  # Saving a partial sweep would silently drop the missing half's fingerprints
  # and make them all look NEW next time. Report the gap instead.
  echo "!! PARTIAL RUN — the GitHub half did not complete. State NOT saved;"
  echo "!! treat the sections above as the local half only, and re-run once fixed."
elif [ "$SAVE" = "1" ]; then
  cut -f1 "$CURRENT" | sort -u > "$STATE_FILE"
  echo "state saved to $STATE_FILE ($(wc -l < "$STATE_FILE" | tr -d ' ') fingerprints)"
else
  echo "state not saved (--no-save)"
fi
