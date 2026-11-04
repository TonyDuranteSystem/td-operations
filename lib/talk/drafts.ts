/**
 * Message drafts for TD Talk (Antonio, 3 Nov 2026 audit: a half-typed message was lost when you switched chats or tapped back).
 * What is typed in a chat is kept on THIS device under the signed-in person and the chat, comes back when that chat is opened again, and goes away when it is sent or emptied.
 * Text only (files and voice notes are not drafts). Browser storage can be refused (private mode): then drafts simply do not survive, nothing breaks.
 */

export interface DraftStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const PREFIX = 'td-talk-draft'
/** A draft longer than this is not kept (the server refuses a message that long anyway). */
export const MAX_DRAFT_CHARS = 5000

/** One key per person and chat, so a shared phone never shows Luca's half-typed message to Antonio. */
export function draftKey(userId: string | null | undefined, chatId: string | null | undefined): string | null {
  if (!userId || !chatId) return null
  return `${PREFIX}:${userId}:${chatId}`
}

function browserStorage(): DraftStorage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage } catch { return null }
}

export function readDraft(key: string | null, storage: DraftStorage | null = browserStorage()): string {
  if (!key || !storage) return ''
  try { return storage.getItem(key) ?? '' } catch { return '' }
}

/** Saves the text; an empty (or blank) text removes the draft. */
export function writeDraft(key: string | null, text: string, storage: DraftStorage | null = browserStorage()): void {
  if (!key || !storage) return
  try {
    if (text.trim().length === 0) storage.removeItem(key)
    else storage.setItem(key, text.slice(0, MAX_DRAFT_CHARS))
  } catch { /* storage full or refused: the draft just is not kept */ }
}
