/**
 * Pinned messages (TD Marketing chats; pure). A pinned message is one the team wants to keep in view: it sits in a bar at the top of its chat.
 * The list is built only from the messages the viewer was already given, so a setter can never be shown a pin of a message she may not read.
 */
import type { TalkMessage } from '@/lib/talk/chat-model'

/** The pinned messages that are still there (a deleted message loses its pin), newest pin first. */
export function pinnedMessages<T extends Pick<TalkMessage, 'pinned_at' | 'deleted_at'>>(list: readonly T[]): T[] {
  return list.filter(m => !!m.pinned_at && !m.deleted_at).sort((a, b) => (Date.parse(b.pinned_at ?? '') || 0) - (Date.parse(a.pinned_at ?? '') || 0))
}

/** The pin to show after `currentId` (the bar steps through them one by one); wraps round, and starts at the newest when nothing is shown yet. */
export function nextPinned<T extends { id: string }>(pins: readonly T[], currentId: string | null): T | null {
  if (pins.length === 0) return null
  const at = pins.findIndex(p => p.id === currentId)
  return pins[(at + 1) % pins.length]
}

/** A pin or unpin I just did, remembered for a little while so a refresh that was already on its way (and still carries the old state) cannot flip it back. */
export type PinOverride = { at: string | null; until: number }
export const PIN_OVERRIDE_MS = 15_000

export function applyPinOverrides<T extends { id: string; pinned_at?: string | null }>(list: readonly T[], overrides: ReadonlyMap<string, PinOverride>, now: number): T[] {
  if (overrides.size === 0) return list.slice()
  return list.map(m => { const o = overrides.get(m.id); return o && o.until > now ? { ...m, pinned_at: o.at } : m })
}

/** The pins the bar shows: those among the loaded messages, plus the ones older than the loaded window (a pin must not drop out because 500 newer messages arrived). */
export function allPins<T extends Pick<TalkMessage, 'id' | 'pinned_at' | 'deleted_at'>>(loaded: readonly T[], older: readonly T[]): T[] {
  const have = new Set(loaded.map(m => m.id))
  return pinnedMessages([...loaded, ...older.filter(o => !have.has(o.id))])
}
