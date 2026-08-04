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
trap 'rm -f "$CURRENT"' EXIT

# emit <fingerprint> <human-readable line>
# The fingerprint is what gets diffed run-to-run, so it must change only when
# the *situation* changes — never embed today's date in it.
emit() { printf '%s\t%s\n' "$1" "$2" >> "$CURRENT"; }

echo "=== DryDock daily sweep — $(date '+%Y-%m-%d %H:%M') ==="
echo

# ---------------------------------------------------------------- GitHub ----
if command -v gh >/dev/null 2>&1; then
  # Open PRs authored by a human (bot PRs are collapsed into one line each so a
  # daily auto-scrape bot can't flood the report).
  gh search prs --owner "$GH_OWNER" --state open --limit 60 \
      --json repository,number,title,author \
      --jq '.[]|"\(.repository.name)\t\(.number)\t\(.author.login)\t\(.title)"' 2>/dev/null |
  while IFS=$'\t' read -r repo num author title; do
    [ -n "${repo:-}" ] || continue
    case "$author" in
      *"[bot]") emit "pr:$repo#$num" "PR  $repo#$num [bot] $title" ;;
      *)        emit "pr:$repo#$num" "PR  $repo#$num @$author $title" ;;
    esac
  done

  gh search issues --owner "$GH_OWNER" --state open --limit 60 \
      --json repository,number,title \
      --jq '.[]|"\(.repository.name)\t\(.number)\t\(.title)"' 2>/dev/null |
  while IFS=$'\t' read -r repo num title; do
    [ -n "${repo:-}" ] || continue
    emit "issue:$repo#$num" "ISS $repo#$num $title"
  done
else
  echo "!! gh not on PATH — skipping the GitHub half of the sweep" >&2
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
cut -f2 "$CURRENT"

if [ "$SAVE" = "1" ]; then
  cut -f1 "$CURRENT" | sort -u > "$STATE_FILE"
  echo
  echo "state saved to $STATE_FILE"
fi
