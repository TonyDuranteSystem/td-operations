/**
 * The light chat list for TD Talk (dev job cf265457: "going back to the chat list takes 10-15 seconds").
 *
 * `GET /api/team/threads` is shared by eight screens and answers for every kind of thread (client discussions, channels, direct messages, groups), which
 * costs several lookups one after another and a few hundred kB. TD Talk draws only direct messages and groups, and it asks for that list every 10 seconds,
 * so it asks for `?scope=chats`: the same rows for those two kinds, without the lookups only the other screens need. Every other caller still gets the
 * full answer. Pure on purpose (no network), unit-tested.
 */
import type { TalkThread } from '@/lib/talk/chat-model'

export const CHAT_LIST_SCOPE = 'chats'

/** What TD Talk asks for. */
export const CHAT_LIST_URL = `/api/team/threads?scope=${CHAT_LIST_SCOPE}`

/** Does this request (a full URL or just the path + query) ask for the light chat list? */
export function wantsChatsOnly(url: string): boolean {
  try {
    return new URL(url, 'http://localhost').searchParams.get('scope') === CHAT_LIST_SCOPE
  } catch {
    return false
  }
}

/** The rows TD Talk draws: direct messages and groups, exactly as the full answer carries them (archived ones included; the screen hides them itself). */
export function chatRows<T extends { thread_type?: string | null }>(rows: readonly T[]): T[] {
  return rows.filter(t => t.thread_type === 'dm' || t.thread_type === 'group')
}

/**
 * One chat's unread number back to 0 on the list — for the chat that is open and being looked at: opening it marks it read on the server, and the list
 * would otherwise show the old number the moment you go back, until its next refresh. Returns the SAME array when there is nothing to clear.
 */
export function withUnreadCleared(threads: TalkThread[], threadId: string): TalkThread[] {
  const hit = threads.find(t => t.id === threadId)
  if (!hit || !hit.unread_count) return threads
  return threads.map(t => (t.id === threadId ? { ...t, unread_count: 0 } : t))
}
