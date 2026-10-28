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
