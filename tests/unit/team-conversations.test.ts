import { describe, it, expect } from 'vitest'
import { parseClientRef, clientRefColumn, conversationTitle, defaultTopicName } from '@/lib/team/conversations'

const UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'

describe('parseClientRef', () => {
  it('parses an account ref', () => {
    expect(parseClientRef(`account:${UUID}`)).toEqual({ kind: 'account', id: UUID })
  })
  it('parses contact and lead refs', () => {
    expect(parseClientRef(`contact:${UUID}`)).toEqual({ kind: 'contact', id: UUID })
    expect(parseClientRef(`lead:${UUID}`)).toEqual({ kind: 'lead', id: UUID })
  })
  it('rejects unknown kind', () => {
    expect(parseClientRef(`deal:${UUID}`)).toBeNull()
  })
  it('rejects a non-uuid id', () => {
    expect(parseClientRef('account:not-a-uuid')).toBeNull()
  })
  it('rejects missing colon / empty', () => {
    expect(parseClientRef('account')).toBeNull()
    expect(parseClientRef('')).toBeNull()
  })
  it('keeps a uuid that itself contains colons out — only splits on first colon', () => {
    // value like "account:uuid" — first colon splits; extra text fails uuid check
    expect(parseClientRef(`account:${UUID}:extra`)).toBeNull()
  })
})

describe('clientRefColumn', () => {
  it('maps each kind to its FK column', () => {
    expect(clientRefColumn('account')).toBe('account_id')
    expect(clientRefColumn('contact')).toBe('contact_id')
    expect(clientRefColumn('lead')).toBe('lead_id')
  })
})

describe('conversationTitle', () => {
  it('joins client + topic with a middot', () => {
    expect(conversationTitle('Acme LLC', 'Banking')).toBe('Acme LLC · Banking')
  })
  it('returns just the client when no topic', () => {
    expect(conversationTitle('Acme LLC', '')).toBe('Acme LLC')
    expect(conversationTitle('Acme LLC', null)).toBe('Acme LLC')
  })
  it('falls back to Client for empty name', () => {
    expect(conversationTitle('', 'Tax')).toBe('Client · Tax')
  })
})

// Erika Hall review, 2026-09-08: an internal topic left blank at creation has
// no other identity to fall back on the way a client conversation falls back
// on the client's own name — so it gets a dated default rather than either a
// hard validation error or a truly nameless thread.
describe('defaultTopicName', () => {
  it('formats as "Topic — <Mon> <day>"', () => {
    expect(defaultTopicName(new Date('2026-09-08T12:00:00Z'))).toBe('Topic — Sep 8')
  })

  it('uses the current date when none is passed', () => {
    // Not asserting an exact string (that would just re-implement Date.now
    // flakily) — only that it produces the same shape the explicit-date case
    // does, so a caller never sees a blank or malformed default.
    expect(defaultTopicName()).toMatch(/^Topic — [A-Z][a-z]{2} \d{1,2}$/)
  })

  it('formats the month name correctly at a year boundary', () => {
    expect(defaultTopicName(new Date('2026-01-01T12:00:00Z'))).toBe('Topic — Jan 1')
  })
})
