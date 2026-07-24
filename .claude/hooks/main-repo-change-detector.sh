#!/bin/bash
# main-repo-change-detector.sh — PostToolUse hook (Bash), worktree sessions only.
#
# THE SAFETY NET. worktree-write-guard.sh blocks file writes aimed at the main
# checkout, but a shell command can reach it by routes no string-matcher can
# predict. So instead of guessing what a command WILL do, this looks at what
# actually HAPPENED: after a Bash call, did the main checkout's working tree
# change? Observation cannot be fooled by quoting, shell variables, a relative
# write after a `cd`, `tee`, heredocs, or a build tool's output.
#
# It NEVER blocks — PostToolUse runs after the fact. It reports, loudly, while
# the change is still fresh and trivially movable. That is enough, because the
# damage in the 2026-07-24 incident was not the write itself: it was the repo's
# 5-minute auto-pull auto-stashing the uncommitted work minutes later, off the
# branch the session thought it was on. Catching it immediately prevents that.
#
# WHY THIS REPLACED COMMAND-PARSING: an earlier guard tried to classify Bash
# commands as read-or-write. Verified by direct test, it missed all six realistic
# writes into main and blocked three legitimate reads. Reads must never be
# blocked (the session needs a 360-degree view of the repo), and this hook reads
# no commands at all — so it cannot block anything, ever.
#
# BASELINE: the main checkout may already be dirty for reasons that have nothing
# to do with this session (another session, another window, Antonio editing by
# hand). We snapshot its dirty set on first sight and report only NEWLY appeared
# entries, so pre-existing mess is never blamed on this session.
#
# Cost: one `git status --porcelain` against the main checkout, ~30ms measured on
# this repo (2026-07-24).
#
# Silence it for a session with: MAIN_REPO_DETECTOR_OFF=1
#
# Test: sh .claude/hooks/test-main-repo-change-detector.sh

INPUT=$(cat 2>/dev/null)

[ "${MAIN_REPO_DETECTOR_OFF:-}" = "1" ] && exit 0

# ── Worktree session? Otherwise "changes in main" is just normal work. ──────
SESSION_TOP=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
[ -n "$SESSION_TOP" ] || exit 0
COMMON_DIR=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0
[ -n "$COMMON_DIR" ] || exit 0
MAIN_ROOT=$(dirname "$COMMON_DIR")
[ "$SESSION_TOP" != "$MAIN_ROOT" ] || exit 0

SESSION_ID=$(printf '%s' "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('session_id','default'))" 2>/dev/null || echo "default")
[ -n "$SESSION_ID" ] || SESSION_ID="default"

# One baseline per (session, worktree).
KEY=$(printf '%s|%s' "$SESSION_ID" "$SESSION_TOP" | shasum 2>/dev/null | cut -c1-16)
[ -n "$KEY" ] || KEY="default"
BASELINE="/tmp/claude-main-dirty-${KEY}"

# Current dirty set of the MAIN checkout (paths only, sorted for stable diffing).
CURRENT=$(git -C "$MAIN_ROOT" status --porcelain --untracked-files=all 2>/dev/null | sed 's/^...//' | sort)

# First sight: record and stay quiet. Pre-existing mess is not ours.
if [ ! -f "$BASELINE" ]; then
  printf '%s\n' "$CURRENT" > "$BASELINE"
  exit 0
fi

NEW=$(comm -13 "$BASELINE" <(printf '%s\n' "$CURRENT") 2>/dev/null | sed '/^$/d')

# Re-baseline every time so each change is reported once, not on every call.
printf '%s\n' "$CURRENT" > "$BASELINE"

[ -n "$NEW" ] || exit 0

COUNT=$(printf '%s\n' "$NEW" | wc -l | tr -d ' ')
BRANCH=$(git -C "$MAIN_ROOT" branch --show-current 2>/dev/null)
[ -n "$BRANCH" ] || BRANCH="(detached)"

echo "⚠️  MAIN CHECKOUT CHANGED — ${COUNT} new uncommitted path(s) appeared in the main repo, which is NOT this session's workspace."
echo "    main repo : ${MAIN_ROOT}  (on branch: ${BRANCH})"
echo "    worktree  : ${SESSION_TOP}"
printf '%s\n' "$NEW" | head -20 | sed 's/^/      • /'
[ "$COUNT" -gt 20 ] && echo "      … and $((COUNT - 20)) more"
echo "    If your last command did this, MOVE that work into the worktree now — the repo's"
echo "    5-minute auto-pull auto-stashes uncommitted changes there, and it will be lost"
echo "    from disk and left on the wrong branch (2026-07-24 incident)."
echo "    If another session or a person is working in the main checkout, ignore this."
echo "    Silence for this session: MAIN_REPO_DETECTOR_OFF=1"
exit 0
