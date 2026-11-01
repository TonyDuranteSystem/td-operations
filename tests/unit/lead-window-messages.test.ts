import { describe, it, expect } from 'vitest'
import { buildEmailEvents, buildWhatsAppEvents, mergeMessageEvents, clip, type EmailRow, type ChatRow, type ChatMessageRow } from '@/lib/leads/window-messages'

const email = (over: Partial<EmailRow> = {}): EmailRow => ({
  mailbox: 'support', thread_id: 't1', message_id: 'm1', from_email: 'sofia@example.com', to_emails: ['support@tonydurante.us'],
  subject: 'Two installments?', snippet: 'Can we split the first year in two payments?', internal_date: '2026-11-01T13:12:00Z', lead_id: null, ...over,
})

describe('buildEmailEvents', () => {
  it('one event per thread, dated at the newest message, direction from the lead address', () => {
    const ev = buildEmailEvents([
      email({ message_id: 'm1', internal_date: '2026-10-30T10:00:00Z', from_email: 'support@tonydurante.us', to_emails: ['sofia@example.com'], snippet: 'Hello Sofia' }),
      email({ message_id: 'm2', internal_date: '2026-11-01T13:12:00Z' }),
    ], 'Sofia@Example.com', 'L1')
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({ channel: 'email', direction: 'in', count: 2, date: '2026-11-01T13:12:00Z', matchReason: 'matched by email address', title: 'Two installments?' })
  })
  it('a message we sent is outbound; a stored link is named as such', () => {
    const ev = buildEmailEvents([email({ from_email: 'support@tonydurante.us', lead_id: 'L1' })], 'sofia@example.com', 'L1')
    expect(ev[0]).toMatchObject({ direction: 'out', matchReason: 'linked to this lead' })
  })
  it('the same thread id in two mailboxes stays two events; rows without a date are skipped', () => {
    const ev = buildEmailEvents([email(), email({ mailbox: 'antonio' }), email({ thread_id: 't9', internal_date: null })], 'sofia@example.com', 'L1')
    expect(ev).toHaveLength(2)
  })
  it('an empty subject gets a label and long text is clipped', () => {
    const ev = buildEmailEvents([email({ subject: '  ', snippet: 'x'.repeat(400) })], null, 'L1')
    expect(ev[0].title).toBe('(no subject)')
    expect(ev[0].detail.length).toBeLessThanOrEqual(181)
    expect(ev[0].direction).toBe('out')
  })
})

describe('buildWhatsAppEvents', () => {
  const chat: ChatRow = { id: 'g1', group_name: 'Sofia', lead_id: null, external_group_id: '393330000000@c.us' }
  const msg = (id: string, at: string, dir: string, text: string | null, type = 'text'): ChatMessageRow => ({ id, group_id: 'g1', direction: dir, content_text: text, content_type: type, created_at: at, sender_name: null })

  it('groups a chat per New York day and shows the last three lines', () => {
    const ev = buildWhatsAppEvents([chat], [
      msg('1', '2026-10-29T15:00:00Z', 'inbound', 'Can my partner join?'),
      msg('2', '2026-10-29T15:05:00Z', 'outbound', 'Yes of course'),
      msg('3', '2026-10-29T15:06:00Z', 'inbound', 'Thanks'),
      msg('4', '2026-10-29T15:07:00Z', 'outbound', 'See you Wednesday'),
      msg('5', '2026-10-31T10:00:00Z', 'inbound', 'Hi again'),
    ], 'L1', '393330000000')
    expect(ev).toHaveLength(2)
    const first = ev.find(e => e.count === 4)!
    expect(first.title).toBe('WhatsApp, 4 messages')
    expect(first.detail.split('\n')).toEqual(['You: Yes of course', 'Them: Thanks', 'You: See you Wednesday'])
    expect(first.matchReason).toBe('matched by phone number')
    expect(ev.find(e => e.count === 1)).toMatchObject({ title: 'WhatsApp message', direction: 'in' })
  })
  it('a chat linked to the lead says so; a media message shows its type; foreign chats are ignored', () => {
    const ev = buildWhatsAppEvents([{ ...chat, lead_id: 'L1' }], [
      msg('1', '2026-10-29T15:00:00Z', 'inbound', null, 'image'),
      { ...msg('2', '2026-10-29T15:01:00Z', 'inbound', 'x'), group_id: 'other' },
    ], 'L1', null)
    expect(ev).toHaveLength(1)
    expect(ev[0].matchReason).toBe('chat is linked to this lead')
    expect(ev[0].detail).toBe('Them: [image]')
  })
  it('a late-evening message belongs to the New York day it was sent', () => {
    const ev = buildWhatsAppEvents([chat], [msg('1', '2026-10-30T02:00:00Z', 'inbound', 'a'), msg('2', '2026-10-30T20:00:00Z', 'inbound', 'b')], 'L1', null)
    expect(ev).toHaveLength(2) // Oct 29 evening vs Oct 30 afternoon in New York
  })
})

describe('mergeMessageEvents and clip', () => {
  it('merges newest first', () => {
    const a = buildEmailEvents([email({ internal_date: '2026-10-01T00:00:00Z' })], 'sofia@example.com', 'L1')
    const b = buildEmailEvents([email({ thread_id: 't2', internal_date: '2026-11-01T00:00:00Z' })], 'sofia@example.com', 'L1')
    expect(mergeMessageEvents(a, b).map(e => e.date)).toEqual(['2026-11-01T00:00:00Z', '2026-10-01T00:00:00Z'])
  })
  it('clip collapses whitespace and handles null', () => {
    expect(clip('a \n  b')).toBe('a b')
    expect(clip(null)).toBe('')
    expect(clip('abcdef', 3)).toBe('abc…')
  })
})
