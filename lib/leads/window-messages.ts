// Emails and WhatsApp chats of a lead, as story events for the lead window (dev job 6fc63c52, phase C).
//
// Pure: the route reads the rows, this turns them into a few readable lines. Email is grouped per thread
// (one line with the newest snippet), WhatsApp per chat per New York day ("WhatsApp, 14 messages") with the
// last few lines. Every line says WHY it was matched to this lead, so a wrong match is visible and can be
// told apart from a right one. Previews are short on purpose: the window is a story, not an inbox.

import { nyDate } from '@/lib/leads/ny-date'

export interface EmailRow {
  mailbox: string
  thread_id: string
  message_id: string
  from_email: string | null
  to_emails: string[] | null
  subject: string | null
  snippet: string | null
  internal_date: string | null
  lead_id: string | null
}

export interface ChatRow { id: string; group_name: string | null; lead_id: string | null; external_group_id: string }

export interface ChatMessageRow {
  id: string
  group_id: string
  direction: string
  content_text: string | null
  content_type: string
  created_at: string
  sender_name: string | null
}

export interface MessageEvent {
  date: string
  channel: 'email' | 'whatsapp'
  direction: 'in' | 'out'
  title: string
  detail: string
  matchReason: string
  sourceId: string
  count: number
}

const PREVIEW = 180

export function clip(text: string | null | undefined, max = PREVIEW): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max).trimEnd() + '…' : t
}

/** One event per email thread, dated at its newest message. */
export function buildEmailEvents(rows: EmailRow[], leadEmail: string | null, leadId: string): MessageEvent[] {
  const mine = (leadEmail ?? '').trim().toLowerCase()
  const byThread = new Map<string, EmailRow[]>()
  for (const r of rows) {
    if (!r.internal_date) continue
    const k = `${r.mailbox}:${r.thread_id}`
    byThread.set(k, [...(byThread.get(k) ?? []), r])
  }
  const events: MessageEvent[] = []
  for (const [k, msgs] of Array.from(byThread.entries())) {
    const sorted = [...msgs].sort((a, b) => (b.internal_date as string).localeCompare(a.internal_date as string))
    const newest = sorted[0]
    const fromLead = !!mine && (newest.from_email ?? '').toLowerCase() === mine
    events.push({
      date: newest.internal_date as string,
      channel: 'email',
      direction: fromLead ? 'in' : 'out',
      title: clip(newest.subject, 90) || '(no subject)',
      detail: clip(newest.snippet),
      matchReason: msgs.some(m => m.lead_id === leadId) ? 'linked to this lead' : 'matched by email address',
      sourceId: k,
      count: msgs.length,
    })
  }
  return events
}

/** One event per chat per New York day. */
export function buildWhatsAppEvents(chats: ChatRow[], messages: ChatMessageRow[], leadId: string, phoneDigits: string | null): MessageEvent[] {
  const chatById = new Map(chats.map(c => [c.id, c]))
  const groups = new Map<string, ChatMessageRow[]>()
  for (const m of messages) {
    if (!chatById.has(m.group_id)) continue
    const k = `${m.group_id}:${nyDate(m.created_at)}`
    groups.set(k, [...(groups.get(k) ?? []), m])
  }
  const events: MessageEvent[] = []
  for (const [k, msgs] of Array.from(groups.entries())) {
    const sorted = [...msgs].sort((a, b) => a.created_at.localeCompare(b.created_at))
    const chat = chatById.get(sorted[0].group_id) as ChatRow
    const last = sorted[sorted.length - 1]
    const lines = sorted.slice(-3).map(m => {
      const who = m.direction === 'inbound' ? 'Them' : 'You'
      const text = clip(m.content_text, 90) || `[${m.content_type}]`
      return `${who}: ${text}`
    })
    const viaPhone = !!phoneDigits && chat.external_group_id.replace(/\D/g, '') === phoneDigits
    events.push({
      date: last.created_at,
      channel: 'whatsapp',
      direction: last.direction === 'inbound' ? 'in' : 'out',
      title: sorted.length === 1 ? 'WhatsApp message' : `WhatsApp, ${sorted.length} messages`,
      detail: lines.join('\n'),
      matchReason: chat.lead_id === leadId ? 'chat is linked to this lead' : viaPhone ? 'matched by phone number' : 'linked contact',
      sourceId: k,
      count: sorted.length,
    })
  }
  return events
}

export function mergeMessageEvents(...lists: MessageEvent[][]): MessageEvent[] {
  return lists.flat().sort((a, b) => b.date.localeCompare(a.date))
}
