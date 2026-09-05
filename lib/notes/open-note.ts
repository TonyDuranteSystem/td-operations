/**
 * Open the floating notes layer on a specific note, from anywhere — mirrors
 * lib/team/open-team-chat.ts's requestOpenTeamChat exactly, same reasoning:
 * the event name lives HERE once, dispatcher and receiver both import it.
 *
 * HOW THE FALLBACK WORKS: the event is cancelable. The floating notes layer
 * calls preventDefault ONLY when it can actually show the note (found it in
 * its already-loaded feed, or fetched it successfully). dispatchEvent returns
 * false when preventDefault was called, so requestOpenNote returns TRUE =
 * handled. FALSE = the caller navigates to /notes?note=<id> instead (the
 * layer isn't mounted, or the note couldn't be loaded) — the button always
 * does something, never a dead click.
 */

export const OPEN_NOTE_EVENT = 'td-open-note'

export interface OpenNoteDetail {
  noteId: string
}

/** Ask the floating notes layer to open a note. Returns true if it handled it. */
export function requestOpenNote(detail: OpenNoteDetail): boolean {
  if (typeof document === 'undefined') return false
  const evt = new CustomEvent(OPEN_NOTE_EVENT, { detail, cancelable: true })
  return document.dispatchEvent(evt) === false
}
