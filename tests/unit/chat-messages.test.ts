/**
 * Floating chat window — message merging, tombstones, and notes made from chat.
 *
 * The two headline cases: a sent message must not appear twice, and a retracted
 * message must never show its original text on a surface that only prints the
 * body it was handed.
 */
import { describe, it, expect } from 'vitest'
import {
  mergeChatMessages,
  displayBody,
  isDeleted,
  attachmentCount,
  buildNoteFromMessage,
  buildNoteFromConversation,
  DELETED_MESSAGE_TEXT,
  type ChatMessage,
} from '@/lib/team/chat-messages'

const msg = (over: Partial<ChatMessage> & { id: string }): ChatMessage => ({
  sender_name: 'Luca',
  message: 'hello',
  created_at: '2026-07-22T10:00:00Z',
  ...over,
})

describe('mergeChatMessages', () => {
  it('THE DOUBLE SEND: the optimistic copy and the realtime copy collapse to one row', () => {
    const optimistic = [msg({ id: 'm1', message: 'sent it' })]
    const fromRealtime = [msg({ id: 'm1', message: 'sent it' })]
    expect(mergeChatMessages(optimistic, fromRealtime)).toHaveLength(1)
  })

  it('orders oldest to newest', () => {
    const out = mergeChatMessages(
      [msg({ id: 'b', created_at: '2026-07-22T11:00:00Z' })],
      [msg({ id: 'a', created_at: '2026-07-22T09:00:00Z' })],
    )
    expect(out.map((m) => m.id)).toEqual(['a', 'b'])
  })

  it('is stable when two messages share a timestamp', () => {
    const out = mergeChatMessages(
      [msg({ id: 'z', created_at: 'T' }), msg({ id: 'a', created_at: 'T' })],
      [],
    )
    expect(out.map((m) => m.id)).toEqual(['a', 'z'])
  })

  it('THE LIVE DELETION: an update overwrites the row it amends', () => {
    const before = [msg({ id: 'm1', message: 'the client owes $48,000' })]
    const after = mergeChatMessages(before, [{ id: 'm1', deleted_at: '2026-07-22T10:05:00Z' }])
    expect(after).toHaveLength(1)
    expect(displayBody(after[0])).toBe(DELETED_MESSAGE_TEXT)
  })

  it('an edit replaces the body rather than adding a second row', () => {
    const out = mergeChatMessages([msg({ id: 'm1', message: 'draft' })], [{ id: 'm1', message: 'final' }])
    expect(out).toHaveLength(1)
    expect(out[0].message).toBe('final')
  })

  it('tolerates empty and missing inputs', () => {
    expect(mergeChatMessages(null, null)).toEqual([])
    expect(mergeChatMessages(undefined, [msg({ id: 'a' })])).toHaveLength(1)
  })
})

describe('displayBody', () => {
  it('NEVER shows a retracted message\'s text', () => {
    // The thread endpoint deliberately returns deleted rows body-and-all so a
    // tombstone can be drawn in the right place. Printing `message` directly is
    // how the retracted figure ends up back on screen.
    const deleted = msg({ id: 'm', message: 'the client owes $48,000', deleted_at: '2026-07-22T10:05:00Z' })
    expect(displayBody(deleted)).toBe(DELETED_MESSAGE_TEXT)
    expect(displayBody(deleted)).not.toContain('48,000')
  })

  it('shows a normal body', () => {
    expect(displayBody(msg({ id: 'm', message: 'on the phone now' }))).toBe('on the phone now')
  })

  it('labels an attachment-only message rather than rendering blank', () => {
    expect(displayBody(msg({ id: 'm', message: '', attachments: [{ name: 'a.csv' }] }))).toBe('Attachment')
  })

  it('returns empty for a genuinely empty message', () => {
    expect(displayBody(msg({ id: 'm', message: '   ' }))).toBe('')
    expect(displayBody(null)).toBe('')
  })
})

describe('isDeleted / attachmentCount', () => {
  it('reports deletion', () => {
    expect(isDeleted(msg({ id: 'm', deleted_at: 'now' }))).toBe(true)
    expect(isDeleted(msg({ id: 'm' }))).toBe(false)
  })

  it('counts attachments without exposing them', () => {
    expect(attachmentCount(msg({ id: 'm', attachments: [1, 2] }))).toBe(2)
    expect(attachmentCount(msg({ id: 'm', attachments: 'not-an-array' }))).toBe(0)
    expect(attachmentCount(msg({ id: 'm' }))).toBe(0)
  })
})

describe('buildNoteFromMessage', () => {
  it('carries who said it, so the quote stays attributable', () => {
    expect(buildNoteFromMessage(msg({ id: 'm', sender_name: 'Luca', message: 'call the IRS' }), 4000))
      .toBe('Luca: call the IRS')
  })

  it('uses the real note limit, not 200 characters', () => {
    const long = 'x'.repeat(1000)
    const out = buildNoteFromMessage(msg({ id: 'm', sender_name: 'L', message: long }), 4000)
    expect(out.length).toBeGreaterThan(200)
  })

  it('truncates at the limit with an ellipsis', () => {
    const out = buildNoteFromMessage(msg({ id: 'm', sender_name: 'L', message: 'y'.repeat(500) }), 50)
    expect(out).toHaveLength(50)
    expect(out.endsWith('…')).toBe(true)
  })

  it('a note made from a retracted message quotes the tombstone, not the text', () => {
    const out = buildNoteFromMessage(msg({ id: 'm', message: 'secret', deleted_at: 'now' }), 4000)
    expect(out).toContain(DELETED_MESSAGE_TEXT)
    expect(out).not.toContain('secret')
  })
})

describe('buildNoteFromConversation', () => {
  const convo = [
    msg({ id: '1', sender_name: 'Antonio', message: 'morning' }),
    msg({ id: '2', sender_name: 'Luca', message: 'morning' }),
    msg({ id: '3', sender_name: 'Antonio', message: 'we agreed: file the extension' }),
  ]

  it('keeps the whole conversation when it fits', () => {
    const out = buildNoteFromConversation(convo, 4000)
    expect(out).toContain('Antonio: morning')
    expect(out).toContain('Antonio: we agreed: file the extension')
  })

  it('THE DECISION SURVIVES: when it does not fit, the END is kept, not the greeting', () => {
    // 100 is tight enough to genuinely force a drop — at 120 the whole thing
    // fits and the test would pass without exercising the truncation at all.
    const out = buildNoteFromConversation(convo, 100)
    expect(out).toContain('we agreed: file the extension')
    expect(out).not.toContain('Antonio: morning')
  })

  it('says how many earlier messages were dropped instead of truncating silently', () => {
    const out = buildNoteFromConversation(convo, 100)
    expect(out).toMatch(/1 earlier message not included/)
  })

  it('never exceeds the limit', () => {
    const many = Array.from({ length: 200 }, (_, i) => msg({ id: `m${i}`, message: 'z'.repeat(60) }))
    expect(buildNoteFromConversation(many, 4000).length).toBeLessThanOrEqual(4000)
  })

  it('handles an empty conversation', () => {
    expect(buildNoteFromConversation([], 4000)).toBe('')
    expect(buildNoteFromConversation(null, 4000)).toBe('')
  })
})
