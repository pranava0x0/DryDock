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

base_tree=$(g rev-parse --verify --quiet "$base^{tree}" 2>/dev/null || true)

# The actual question is "would merging this branch change base?", so ask it
# directly: merge in memory and compare the resulting tree to base's.
#
# This replaces a patch-id comparison that was wrong in a common case. Replaying
# the branch as one commit on its merge base produces a *different patch* from
# the squash commit whenever base edited the same region first — the squash's
# diff is against already-modified base, the probe's is against the old fork
# point, and differing context lines mean differing patch-ids. `git cherry` then
# reports shipped work as outstanding. Trees have no such sensitivity: two
# routes to the same content produce the same tree oid.
#
# --write-tree requires git 2.38+. Probed rather than assumed, because the old
# three-argument form of merge-tree would silently misread these arguments.
if [ -n "$base_tree" ] &&
   probe=$(g merge-tree --write-tree "$base" "$base" 2>/dev/null) &&
   [ "$probe" = "$base_tree" ]; then
  if merged=$(g merge-tree --write-tree "$base" "$branch" 2>/dev/null); then
    # A conflict exits nonzero and lands below as unmerged — correctly, since a
    # branch that cannot be merged cleanly plainly still has work in it.
    if [ "$merged" = "$base_tree" ]; then
      echo "stale $ahead"
      exit 0
    fi
  fi
  echo "unmerged $ahead"
  exit 0
fi

# ---- Fallback for git < 2.38 -----------------------------------------------
# Weaker than the merge-tree path above (it is the patch-id logic, with the
# same-region blind spot), but better than reporting every squash-merged branch
# as outstanding work.
mb=$(g merge-base "$base" "$branch" 2>/dev/null || true)
if [ -z "$mb" ]; then
  # No common ancestor. Not something we can call shipped.
  echo "unmerged $ahead"
  exit 0
fi

# Contributes nothing over the fork point — an empty branch, or one that merged
# base back in after being squashed, which moves the merge base onto the squash
# commit. That topology reaches the patch-id probe as an *empty* commit, which
# `git cherry` correctly reports as `+`, so this test has to come first.
if g diff --quiet "$mb" "$branch" 2>/dev/null; then
  echo "stale $ahead"
  exit 0
fi

sq=$(g commit-tree "$branch^{tree}" -p "$mb" -m squash-probe 2>/dev/null || true)
if [ -n "$sq" ] && g cherry "$base" "$sq" 2>/dev/null | grep -q '^-'; then
  echo "stale $ahead"
  exit 0
fi

echo "unmerged $ahead"
