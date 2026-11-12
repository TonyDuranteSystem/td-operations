#!/bin/sh
# check-release-note.sh — Releases gate (dev job 616dc839).
#
# Every change that reaches the live CRM must say, in plain English, what it does — that is what the blue "New release available" bar
# shows the team before they refresh, and what the Releases page keeps. So a push that changes APP code must also ADD a release note
# (content/releases/<id>.json). Tests, docs, scripts, hooks and notes alone need none.
#
# Also keeps the notes in time order: a new note must sort AFTER the newest note already on main, otherwise a page built in between
# would never be told about it (the panel lists notes newer than the one a page was built with). Fix = make a fresh file with
#   node scripts/new-release-note.js <short-name>
# and move your text into it.
#
# Override (rare, deliberate — e.g. a change that really has nothing to say):  ALLOW_RELEASE_NOTE_SKIP=1 git push ...
# Test:  CHANGED_FILES="lib/x.ts" ADDED_FILES="" NEWEST_ON_MAIN="" sh scripts/check-release-note.sh
#
# Exit 0 = ok; exit 1 = blocked.

CHANGED="${CHANGED_FILES-$(git diff --name-only origin/main...HEAD 2>/dev/null)}"
ADDED="${ADDED_FILES-$(git diff --name-only --diff-filter=A origin/main...HEAD 2>/dev/null)}"
NEWEST="${NEWEST_ON_MAIN-$(git ls-tree --name-only origin/main content/releases/ 2>/dev/null | sed -n 's#^content/releases/##p' | sed 's#\.json$##' | LC_ALL=C sort | tail -n 1)}"

[ -n "$CHANGED" ] || exit 0

# App code = what runs in the live CRM / portal: pages, components, libraries, static files (not the notes' own pictures), the two root configs.
APP_CODE=$(printf '%s\n' "$CHANGED" | grep -E '^(app|components|lib)/|^public/|^middleware\.ts$|^next\.config\.js$' | grep -v '^public/release-notes/')
[ -n "$APP_CODE" ] || exit 0

NEW_NOTES=$(printf '%s\n' "$ADDED" | sed -n 's#^content/releases/\(.*\)\.json$#\1#p')

fail() {
  echo ""
  echo "❌ PUSH BLOCKED — release note needed (Releases)."
  echo "$1"
  echo ""
  echo "   Write what this change does, in plain English for the team:"
  echo "     node scripts/new-release-note.js <short-name>      (makes content/releases/<id>.json — fill it in)"
  echo "   A change nobody will see (a refactor, internal plumbing) still gets a note, tagged \"behind-the-scenes\" (hidden by default)."
  echo "   Really nothing to say? Override deliberately with:  ALLOW_RELEASE_NOTE_SKIP=1 git push ..."
  echo ""
  if [ "${ALLOW_RELEASE_NOTE_SKIP:-}" = "1" ]; then
    echo "   ALLOW_RELEASE_NOTE_SKIP=1 set — continuing without a release note."
    echo ""
    exit 0
  fi
  exit 1
}

if [ -z "$NEW_NOTES" ]; then
  fail "   You changed app code but added no release note. Changed, for example:
$(printf '%s\n' "$APP_CODE" | head -3 | sed 's/^/     - /')"
fi

# Each new note must be newer than the newest one on main.
for id in $NEW_NOTES; do
  [ -n "$NEWEST" ] || continue
  top=$(printf '%s\n%s\n' "$id" "$NEWEST" | LC_ALL=C sort | tail -n 1)
  if [ "$id" = "$NEWEST" ] || [ "$top" != "$id" ]; then
    fail "   The note \"$id\" is not newer than the newest note on main (\"$NEWEST\").
   Another change was released after you started; rename your note with a later time (the part after the date)."
  fi
done

exit 0
