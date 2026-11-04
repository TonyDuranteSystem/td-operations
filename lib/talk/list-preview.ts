/**
 * The chat list's second line and the unread count on the app icon / tab (Antonio, 3 Nov 2026 audit: the list showed only a time; nothing showed unread outside the page).
 * Pure rules, unit-tested; the two browser helpers at the bottom only touch `navigator` / `document` and never throw.
 */
import { snippet, type TalkMember, type TalkThread } from '@/lib/talk/chat-model'

/** What the server sends for a chat's newest message (see `GET /api/team/threads`). */
export interface LastMessageRow { message: string | null; attachments: unknown; sender_id: string | null }

/** The short text for a message row: its words, or "🎤 Voice message" / "📷 Photo" / "📎 file name". */
export function lastMessagePreview(row: LastMessageRow): string {
  return snippet({ message: row.message ?? '', attachments: Array.isArray(row.attachments) ? (row.attachments as never) : null, deleted_at: null }, 80)
}

/** "You: Ok", in a group "Luca: Ok", in a direct message just the words. Empty when the chat has no message yet. */
export function previewLine(t: Pick<TalkThread, 'thread_type' | 'last_message_preview' | 'last_message_sender_id'>, meId: string | null, members: readonly TalkMember[]): string {
  const text = (t.last_message_preview ?? '').trim()
  if (!text) return ''
  const sender = t.last_message_sender_id ?? null
  if (sender && meId && sender === meId) return `You: ${text}`
  if (t.thread_type === 'group' && sender) {
    const name = members.find(m => m.id === sender)?.name
    const first = name ? name.split(/\s+/)[0] : ''
    return first ? `${first}: ${text}` : text
  }
  return text
}

/** All unread messages, except the chat that is open AND being looked at (it reads itself). */
export function unreadTotal(chats: ReadonlyArray<Pick<TalkThread, 'id' | 'unread_count'>>, openId: string | null, viewing: boolean): number {
  let n = 0
  for (const c of chats) {
    if (viewing && c.id === openId) continue
    const u = c.unread_count ?? 0
    if (u > 0) n += u
  }
  return n
}

/** "(3) TD Talk" — the count in front of the title, nothing when there is nothing unread. */
export function titleWithCount(baseTitle: string, count: number): string {
  const base = baseTitle.replace(/^\(\d+\+?\)\s*/, '')
  if (!(count > 0)) return base
  return `(${count > 99 ? '99+' : count}) ${base}`
}

let originalTitle: string | null = null

/** Puts the unread count on the app icon (where the browser allows it) and in the tab title. Safe to call anywhere; does nothing it cannot do. */
export function applyUnreadIndicators(count: number): void {
  try {
    if (typeof document !== 'undefined') {
      if (originalTitle === null) originalTitle = document.title.replace(/^\(\d+\+?\)\s*/, '')
      document.title = titleWithCount(originalTitle, count)
    }
  } catch { /* ignore */ }
  try {
    const nav = (typeof navigator === 'undefined' ? null : navigator) as (Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> }) | null
    if (!nav) return
    if (count > 0 && nav.setAppBadge) void nav.setAppBadge(count).catch(() => {})
    else if (count <= 0 && nav.clearAppBadge) void nav.clearAppBadge().catch(() => {})
  } catch { /* ignore */ }
}

/** Leaving the screen: the title goes back and the icon badge is cleared. */
export function clearUnreadIndicators(): void {
  applyUnreadIndicators(0)
  originalTitle = null
}
