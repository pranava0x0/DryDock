#!/bin/bash
#
# Classify a local branch against main: is there actually work here to merge?
#
# Usage:  branch-merge-state.sh <repo-path> <branch> [base]
# Prints exactly one of:
#   in-sync            — no commits ahead of base (or the ref is unreadable)
#   stale <n>          — n commits ahead, but nothing left to merge
#   unmerged <n>       — n commits ahead, with real outstanding content
#
# Extracted from daily-sweep.sh so it can be tested against fixture histories
# without the sweep's five `gh` calls hitting the network. Both false positives
# this logic shipped (see docs/daily-sweep-log.md, 2026-08-12) were topology
# bugs that a fixture repo catches in milliseconds.
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

ahead=$(g rev-list --count "$base..$branch" 2>/dev/null || echo 0)
[ -z "$ahead" ] && ahead=0
if [ "$ahead" = "0" ]; then
  echo "in-sync"
  exit 0
fi

mb=$(g merge-base "$base" "$branch" 2>/dev/null || true)
if [ -z "$mb" ]; then
  # No common ancestor, or git failed. Either way this is not something we can
  # call shipped — report the work rather than swallowing it.
  echo "unmerged $ahead"
  exit 0
fi

# 1. Contributes nothing over the fork point. Covers an empty branch, and the
#    branch that merged base back in after being squashed — that moves the
#    merge base onto the squash commit, and reaches the patch-id probe below as
#    an *empty* commit, which `git cherry` correctly calls `+` (no equivalent
#    upstream). So this test has to come first.
if g diff --quiet "$mb" "$branch" 2>/dev/null; then
  echo "stale $ahead"
  exit 0
fi

# 2. Replay the branch as a single commit on its merge base — the same shape a
#    squash merge produces — and look for that patch-id anywhere in base's
#    history. `git cherry base branch` does NOT work here: a squash collapses N
#    commits into one, so none of the original patch-ids survive to match.
#
#    Note this compares against base's whole history, not its tip. A tip
#    comparison holds only while the merge being detected is the most recent
#    commit, and silently flips back to a false positive on the next unrelated
#    commit.
sq=$(g commit-tree "$branch^{tree}" -p "$mb" -m squash-probe 2>/dev/null || true)
if [ -n "$sq" ] && g cherry "$base" "$sq" 2>/dev/null | grep -q '^-'; then
  echo "stale $ahead"
  exit 0
fi

# Exit codes and emptiness are deliberately never read as "shipped": a git
# failure leaves $sq empty and lands here, reporting the work.
echo "unmerged $ahead"
