#!/bin/bash
#
# Classify a local branch against main: is there actually work here to merge?
#
# Usage:  branch-merge-state.sh <repo-path> <branch> [base]
# Prints exactly one of:
#   in-sync            — no commits ahead of base
#   stale <n>          — n commits ahead, but nothing left to merge
#   unmerged <n>       — n commits ahead, with real outstanding content
#   unreadable         — the repo or a ref could not be read
#
# Extracted from daily-sweep.sh so it can be tested against fixture histories
# without the sweep's five `gh` calls hitting the network. Every false positive
# this logic has shipped (see docs/daily-sweep-log.md, 2026-08-12) was a
# topology bug that a fixture repo catches in milliseconds.
#
# Why "stale" is not simply "zero commits ahead": this repo squash-merges every
# PR. A squash writes one new commit onto main and leaves every original SHA
# unreachable from it, so a fully-shipped branch still reports its whole commit
# count. The count is honest and tells you nothing about whether the work
# landed.

set -uo pipefail

repo="${1:?usage: branch-merge-state.sh <repo-path> <branch> [base]}"
branch="${2:?usage: branch-merge-state.sh <repo-path> <branch> [base]}"
base="${3:-main}"

g () { git -C "$repo" "$@"; }

# Resolve both endpoints up front. `rev-list --count` fails on a bad ref, and
# defaulting that to 0 would make an unreadable branch indistinguishable from a
# fully-merged one — the caller would then skip it silently, which is the same
# "failure that looks like success" shape this file exists to avoid.
g rev-parse --verify --quiet "$base^{commit}" >/dev/null 2>&1 || { echo "unreadable"; exit 0; }
g rev-parse --verify --quiet "$branch^{commit}" >/dev/null 2>&1 || { echo "unreadable"; exit 0; }

ahead=$(g rev-list --count "$base..$branch" 2>/dev/null) || { echo "unreadable"; exit 0; }
[ -z "$ahead" ] && { echo "unreadable"; exit 0; }
if [ "$ahead" = "0" ]; then
  echo "in-sync"
  exit 0
fi

mb=$(g merge-base "$base" "$branch" 2>/dev/null || true)
if [ -z "$mb" ]; then
  # No common ancestor. Not something we can call shipped.
  echo "unmerged $ahead"
  exit 0
fi

# Two independent tests below, and the branch is stale if *either* fires. That
# is not belt-and-braces: each one is blind exactly where the other sees, and
# both blind spots are ordinary histories that showed up in review.
#
#   patch-id match  — blind when base edited the same region *before* the
#                     squash (differing context, differing patch-id)
#   merged-tree     — blind when base edited the branch's paths *after* the
#                     squash (the merge then changes the tree, or conflicts)

# 1. Contributes nothing over the fork point — an empty branch, or one that
#    merged base back in after being squashed, which moves the merge base onto
#    the squash commit. That reaches the patch-id test below as an *empty*
#    diff, which matches nothing, so this comes first.
#
#    Exit status 1 is "they differ"; anything higher is a failed read (a
#    missing or corrupt tree object still passes the ref checks above). Those
#    must not fall through as "differ" and end up reported as real work.
g diff --quiet "$mb" "$branch" 2>/dev/null
case $? in
  0) echo "stale $ahead"; exit 0 ;;
  1) ;;
  *) echo "unreadable"; exit 0 ;;
esac

# 2. Take the branch's whole diff since the fork point — the same patch a
#    squash merge produces — and look for it anywhere in base's *history*.
#    Being historical is what makes this survive base moving on afterwards.
#
#    --verbatim matters: `git patch-id` normally ignores whitespace, so a base
#    commit adding `foo bar` matches a branch adding `foobar` and genuinely
#    unmerged work would be reported as shipped. That is the one direction this
#    script must never fail in, since the sweep then never mentions the branch
#    again. --verbatim needs git 2.39+, so it is probed; without it, fall back
#    to `git cherry`, which has the whitespace blind spot but is still better
#    than reporting every squash-merged branch as outstanding.
if printf '' | g patch-id --verbatim >/dev/null 2>&1; then
  pid () { g patch-id --verbatim 2>/dev/null | awk '{print $1}'; }
  pid_lines () { g patch-id --verbatim 2>/dev/null; }
  target=$(g diff "$mb" "$branch" 2>/dev/null | pid)
  # One `git log -p` piped into one patch-id, rather than two processes per
  # commit.
  #
  # Deliberately unbounded by default. An earlier cut capped this at 500
  # commits for speed, which made the whole fix *decay*: past the cap the
  # squash commit falls out of the scan, and if base has since touched the
  # branch's paths the merged-tree test can't see the incorporation either, so
  # a long-shipped branch silently reappears as outstanding work. That is this
  # PR's own bug on a timer. SWEEP_PATCH_ID_SCAN exists for a pathological
  # repo, but a bound has to be opted into, never defaulted.
  if [ -n "$target" ]; then
    if [ -n "${SWEEP_PATCH_ID_SCAN:-}" ]; then
      hist=$(g log -p --no-merges -n "$SWEEP_PATCH_ID_SCAN" "$mb..$base" 2>/dev/null | pid_lines)
    else
      hist=$(g log -p --no-merges "$mb..$base" 2>/dev/null | pid_lines)
    fi
    case "$hist" in
      "$target "*|*"
$target "*) echo "stale $ahead"; exit 0 ;;
    esac
  fi
else
  sq=$(g commit-tree "$branch^{tree}" -p "$mb" -m squash-probe 2>/dev/null || true)
  if [ -n "$sq" ] && g cherry "$base" "$sq" 2>/dev/null | grep -q '^-'; then
    echo "stale $ahead"
    exit 0
  fi
fi

# 3. Would merging actually change base? Trees compare content rather than
#    patches, so unlike (2) this is indifferent to what base edited first.
#    --write-tree needs git 2.38+, probed rather than assumed because the old
#    three-argument merge-tree would silently misread these arguments. A
#    conflict exits nonzero and falls through to unmerged, correctly — a branch
#    that will not merge cleanly plainly still has work in it.
# A base commit can resolve while its tree object is missing, which the ref
# checks above cannot see. Without the tree there is nothing to compare against,
# so this is an unreadable repo — not a branch with confirmed outstanding work.
base_tree=$(g rev-parse --verify --quiet "$base^{tree}" 2>/dev/null || true)
if [ -z "$base_tree" ]; then
  echo "unreadable"
  exit 0
fi

if
   probe=$(g merge-tree --write-tree "$base" "$base" 2>/dev/null) &&
   [ "$probe" = "$base_tree" ] &&
   merged=$(g merge-tree --write-tree "$base" "$branch" 2>/dev/null) &&
   [ "$merged" = "$base_tree" ]; then
  echo "stale $ahead"
  exit 0
fi

echo "unmerged $ahead"
