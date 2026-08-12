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
#   patch-id replay   — blind when base edited the same region *before* the
#                       squash (differing context, differing patch-id)
#   merged-tree       — blind when base edited the branch's paths *after* the
#                       squash (the merge then changes the tree, or conflicts)
#
# Neither can turn genuinely outstanding work into "stale": extra commits on
# the branch change the whole-branch patch-id, and a merge that adds them
# necessarily changes the tree.

# 1. Contributes nothing over the fork point — an empty branch, or one that
#    merged base back in after being squashed, which moves the merge base onto
#    the squash commit. That reaches the replay below as an *empty* commit,
#    which `git cherry` correctly reports as `+`, so this comes first.
if g diff --quiet "$mb" "$branch" 2>/dev/null; then
  echo "stale $ahead"
  exit 0
fi

# 2. Replay the branch as one commit on its merge base — the shape a squash
#    merge produces — and look for that patch-id anywhere in base's *history*.
#    Being historical is what makes this survive base moving on afterwards.
#    `git cherry base branch` does not work here: a squash collapses N commits
#    into one, so none of the originals match.
sq=$(g commit-tree "$branch^{tree}" -p "$mb" -m squash-probe 2>/dev/null || true)
if [ -n "$sq" ] && g cherry "$base" "$sq" 2>/dev/null | grep -q '^-'; then
  echo "stale $ahead"
  exit 0
fi

# 3. Would merging actually change base? Trees compare content rather than
#    patches, so unlike (2) this is indifferent to what base edited first.
#    --write-tree needs git 2.38+, probed rather than assumed because the old
#    three-argument merge-tree would silently misread these arguments. A
#    conflict exits nonzero and falls through to unmerged, correctly — a branch
#    that will not merge cleanly plainly still has work in it.
base_tree=$(g rev-parse --verify --quiet "$base^{tree}" 2>/dev/null || true)
if [ -n "$base_tree" ] &&
   probe=$(g merge-tree --write-tree "$base" "$base" 2>/dev/null) &&
   [ "$probe" = "$base_tree" ] &&
   merged=$(g merge-tree --write-tree "$base" "$branch" 2>/dev/null) &&
   [ "$merged" = "$base_tree" ]; then
  echo "stale $ahead"
  exit 0
fi

echo "unmerged $ahead"
