#!/bin/sh
# dev-board-index.sh — SessionStart reminder for the dev-tracker board discipline
# (R112). Every session that does dev work must link to ONE dev job (or create
# one) and keep it current, so nothing is lost across compaction and any later
# session continues cold. Print-only (no DB); the session runs dev_task_list via
# MCP to see the open jobs. Runs from the repo root like the other SessionStart
# hooks.

echo ""
echo "🗂️  DEV-TRACKER BOARD — keep the work tracked (R112)."
echo "   If this session does dev work (feature/bug/refactor), it MUST be tied to ONE job:"
echo "   1. dev_task_list — find the open job for this work and CONTINUE it (don't duplicate)."
echo "   2. No match? dev_task_create with: channel (td-dev|td-bug|td-support), a PLAIN-ENGLISH"
echo "      summary for Antonio, and the technical request."
echo "   3. As you work, keep it current: findings when you investigate, the frozen plan when"
echo "      approved, milestone advances, decisions, and spun-off bugs as CHILD jobs."
echo "   4. Before compaction / at stop, write the job's structured update so the next session"
echo "      picks up cold. The board is at /dev-board."
echo ""
exit 0
