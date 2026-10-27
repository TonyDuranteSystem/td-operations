/**
 * Where the staff Portal Chats page lands when a conversation opens, and which
 * parts of that place survive a refresh (Antonio, 2026-10-27: "when I open a chat
 * it lands on General instead of the topic with the message to read; when I
 * refresh, I start over").
 *
 * Pure helpers so the rules are unit tested (the page is one big client
 * component and this repo has no React test renderer).
 */
import { isChatEventMessage } from '@/lib/portal/chat-scope'

export const STAFF_CHAT_TABS = ['messages', 'whatsnew', 'ideas', 'todo', 'email', 'worker'] as const
export type StaffChatTab = (typeof STAFF_CHAT_TABS)[number]

/** `?tab=` value → a real tab, or null (unknown / absent / the default tab). */
export function parseStaffChatTab(raw: string | null | undefined): StaffChatTab | null {
  if (!raw || raw === 'messages') return null
  return (STAFF_CHAT_TABS as readonly string[]).includes(raw) ? (raw as StaffChatTab) : null
}

/** `?topic=` value → a topic name, or null (General). Blank counts as General. */
export function parseStaffChatTopic(raw: string | null | undefined): string | null {
  const t = (raw ?? '').trim()
  return t ? t : null
}

export interface LandingMessage {
  sender_type: string
  read_at?: string | null
  deleted_at?: string | null
  message: string
  topic?: string | null
  created_at: string
}

/**
 * The topic a freshly opened conversation should open on, or null to stay on General.
 *
 * Same unread definition as the topic-pill badges (client + plain-system rows, not
 * deleted, chat-event notices excluded — those belong to What's New). General wins
 * when it has something unread (it is the tab staff would land on anyway); otherwise
 * the named topic whose newest unread message is most recent.
 */
export function pickUnreadTopicToOpen(messages: readonly LandingMessage[]): string | null {
  let generalUnread = false
  const newestUnreadByTopic = new Map<string, number>()
  for (const m of messages) {
    if (m.sender_type === 'admin' || m.read_at || m.deleted_at) continue
    if (isChatEventMessage(m.message)) continue
    if (!m.topic) { generalUnread = true; continue }
    const t = new Date(m.created_at).getTime()
    const prev = newestUnreadByTopic.get(m.topic)
    if (prev === undefined || t > prev) newestUnreadByTopic.set(m.topic, t)
  }
  if (generalUnread) return null
  let best: string | null = null
  let bestTime = -Infinity
  for (const [topic, t] of Array.from(newestUnreadByTopic)) {
    if (t > bestTime) { best = topic; bestTime = t }
  }
  return best
}

/**
 * Write the topic/tab onto a URL without touching any other key. Defaults (General,
 * Messages) are REMOVED so a plain chat keeps a plain address.
 */
export function applyLandingToUrl(
  href: string,
  landing: { topic: string | null; tab: StaffChatTab },
): string {
  const url = new URL(href)
  if (landing.topic) url.searchParams.set('topic', landing.topic)
  else url.searchParams.delete('topic')
  if (landing.tab !== 'messages') url.searchParams.set('tab', landing.tab)
  else url.searchParams.delete('tab')
  return url.href
}
