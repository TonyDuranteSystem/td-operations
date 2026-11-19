/**
 * Reads content/releases/*.json at BUILD time (next.config.js) so each release carries its own description inside the build.
 * Plain Node (CommonJS): it runs while Next.js loads its config, before any app code exists. Checking a note's shape is done by
 * lib/release/release-notes.ts at run time and by the unit test in CI — here a damaged file is only skipped with a warning, so a bad
 * note can never stop a production build.
 *
 * Gives back two build-time values:
 *   RELEASE_NOTES_JSON       every note, oldest first, as JSON text (read only by lib/release/bundled-notes.ts, on the server)
 *   NEXT_PUBLIC_NEWEST_NOTE  the id of the newest note — the page's "I have seen everything up to here" mark
 */
const fs = require('fs')
const path = require('path')

const NOTE_ID = /^\d{4}-\d{2}-\d{2}-\d{4}-[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Every readable note in `dir` as `{ id, ...fields }`, oldest first. Missing folder → empty list. */
function readReleaseNotes(dir) {
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const notes = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const id = name.slice(0, -'.json'.length)
    if (!NOTE_ID.test(id)) {
      console.warn('[release-notes] skipped ' + name + ': the file name is not a note id')
      continue
    }
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) notes.push(Object.assign({}, raw, { id }))
    } catch (e) {
      console.warn('[release-notes] skipped ' + name + ': ' + (e && e.message ? e.message : e))
    }
  }
  notes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return notes
}

function releaseNotesEnv(dir) {
  const notes = readReleaseNotes(dir)
  return {
    RELEASE_NOTES_JSON: JSON.stringify(notes),
    NEXT_PUBLIC_NEWEST_NOTE: notes.length ? notes[notes.length - 1].id : '',
  }
}

module.exports = { readReleaseNotes, releaseNotesEnv }
