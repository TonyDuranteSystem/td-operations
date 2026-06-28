import { describe, it, expect } from 'vitest'
import {
  validateMessageBody,
  partnerHasCommScope,
  messagePreview,
  isOwnMessage,
  normalizeSubject,
  MAX_MESSAGE_LENGTH,
  TD_COMMUNICATION_SCOPE,
} from '@/lib/td-communication/helpers'

describe('validateMessageBody', () => {
  it('accepts and trims a normal message', () => {
    expect(validateMessageBody('  hello world  ')).toEqual({ body: 'hello world', error: null })
  })

  it('rejects non-string input', () => {
    expect(validateMessageBody(null).error).toBeTruthy()
    expect(validateMessageBody(undefined).body).toBeNull()
    expect(validateMessageBody(42).error).toBeTruthy()
  })

  it('rejects an empty or whitespace-only message', () => {
    expect(validateMessageBody('').error).toBeTruthy()
    expect(validateMessageBody('   \n  ').body).toBeNull()
  })

  it('rejects a message over the max length and reports the size', () => {
    const r = validateMessageBody('x'.repeat(MAX_MESSAGE_LENGTH + 1))
    expect(r.body).toBeNull()
    expect(r.error).toContain(String(MAX_MESSAGE_LENGTH))
  })

  it('accepts a message exactly at the max length', () => {
    const r = validateMessageBody('x'.repeat(MAX_MESSAGE_LENGTH))
    expect(r.error).toBeNull()
    expect(r.body).not.toBeNull()
  })
})

describe('partnerHasCommScope', () => {
  it('grants when the scope array contains td_communication', () => {
    expect(partnerHasCommScope([TD_COMMUNICATION_SCOPE])).toBe(true)
    expect(partnerHasCommScope(['other', TD_COMMUNICATION_SCOPE])).toBe(true)
  })

  it('denies for empty, missing, or unrelated scopes', () => {
    expect(partnerHasCommScope([])).toBe(false)
    expect(partnerHasCommScope(['billing'])).toBe(false)
  })

  it('default-denies non-array input', () => {
    expect(partnerHasCommScope(null)).toBe(false)
    expect(partnerHasCommScope(undefined)).toBe(false)
    expect(partnerHasCommScope('td_communication')).toBe(false)
  })
})

describe('messagePreview', () => {
  it('returns null for no message', () => {
    expect(messagePreview(null)).toBeNull()
    expect(messagePreview(undefined)).toBeNull()
  })

  it('collapses whitespace to one line', () => {
    expect(messagePreview({ body: 'a\n\n  b   c', deleted_at: null })).toBe('a b c')
  })

  it('hides the body of a soft-deleted message (R100)', () => {
    expect(messagePreview({ body: 'secret', deleted_at: '2026-06-27T00:00:00Z' })).toBe('Message deleted')
  })

  it('truncates long bodies with an ellipsis', () => {
    const preview = messagePreview({ body: 'x'.repeat(200), deleted_at: null }, 80)
    expect(preview).not.toBeNull()
    expect((preview as string).length).toBeLessThanOrEqual(80)
    expect(preview).toMatch(/…$/)
  })
})

describe('isOwnMessage', () => {
  const msg = { sender_type: 'partner' as const, sender_id: 'p1' }

  it('is own when type and id both match', () => {
    expect(isOwnMessage(msg, 'partner', 'p1')).toBe(true)
  })

  it('is not own when id differs', () => {
    expect(isOwnMessage(msg, 'partner', 'p2')).toBe(false)
  })

  it('is not own when type differs even if id collides', () => {
    expect(isOwnMessage(msg, 'staff', 'p1')).toBe(false)
  })
})

describe('normalizeSubject', () => {
  it('trims and caps length', () => {
    expect(normalizeSubject('  hi  ')).toBe('hi')
    expect((normalizeSubject('x'.repeat(500)) as string).length).toBe(200)
  })

  it('returns null for empty or non-string', () => {
    expect(normalizeSubject('   ')).toBeNull()
    expect(normalizeSubject(null)).toBeNull()
    expect(normalizeSubject(123)).toBeNull()
  })
})
