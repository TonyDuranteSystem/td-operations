/**
 * "Open replies in the pop-up by default" — a per-DEVICE preference for the reply composer (dev job bbc70ff8,
 * Antonio 2026-10-06: "instead of having a predefined square, can I have a pop up page that I have more space
 * to write and to work on?").
 *
 * Stored in the browser's own localStorage on purpose: it is a personal convenience of one person on one
 * device, so choosing it never changes what Luca (or Antonio's phone) sees. Every storage access is wrapped —
 * localStorage can be absent or throw (a private window, blocked site data, server rendering) — and a failure
 * simply means "not set", never an error on screen. Pure of React so it is unit-testable with a fake storage.
 */

export const REPLY_POPUP_PREF_KEY = 'td.replyPopup.default'

/** The slice of the Storage interface we use — lets tests pass a plain object. */
export interface PrefStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function defaultStorage(): PrefStorage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null
  }
}

/** True only when the preference was explicitly turned on. Anything else (missing, blocked, junk) is off. */
export function readReplyPopupDefault(storage: PrefStorage | null = defaultStorage()): boolean {
  if (!storage) return false
  try {
    return storage.getItem(REPLY_POPUP_PREF_KEY) === '1'
  } catch {
    return false
  }
}

/** Remember (or forget) the choice. Returns whether it was stored — false when storage is unavailable. */
export function writeReplyPopupDefault(on: boolean, storage: PrefStorage | null = defaultStorage()): boolean {
  if (!storage) return false
  try {
    if (on) storage.setItem(REPLY_POPUP_PREF_KEY, '1')
    else storage.removeItem(REPLY_POPUP_PREF_KEY)
    return true
  } catch {
    return false
  }
}
