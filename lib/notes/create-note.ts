/**
 * Open the floating notes layer straight into CREATE mode, pre-filled, from
 * anywhere — mirrors lib/notes/open-note.ts exactly, same reasoning: the
 * event name lives HERE once, dispatcher and receiver both import it.
 *
 * Antonio, 2026-09-18: clicking the WhatsApp row's sticky-note icon was
 * silently POSTing a note in the background with no chance to edit it first
 * ("when I click on sticky note the note pop up must open for me to set it
 * up"). This lets any surface open the SAME full note editor every other
 * "new note" entry point uses, pre-filled, instead of hand-rolling its own
 * create call.
 *
 * Same cancelable-event fallback shape as requestOpenNote: the layer calls
 * preventDefault only when it can actually show the editor (it's mounted).
 * dispatchEvent returns false when preventDefault was called, so
 * requestCreateNote returns TRUE = handled.
 */

import type { CreateDefaults } from '@/components/dashboard/note-editor'

export const CREATE_NOTE_EVENT = 'td-create-note'

export type CreateNoteDetail = CreateDefaults

/** Ask the floating notes layer to open the note editor in create mode, pre-filled. Returns true if it handled it. */
export function requestCreateNote(detail: CreateNoteDetail): boolean {
  if (typeof document === 'undefined') return false
  const evt = new CustomEvent(CREATE_NOTE_EVENT, { detail, cancelable: true })
  return document.dispatchEvent(evt) === false
}
