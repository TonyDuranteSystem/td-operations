import { describe, it, expect } from 'vitest'
import { buildShareCards, composeShareMessage, SHARE_BODY_CAP, MAX_SHARE_ITEMS } from '@/lib/team/share'

describe('buildShareCards', () => {
  it('rejects a non-array', () => {
    const r = buildShareCards(null)
    expect(r.error).toMatch(/nothing to share/i)
    expect(r.cards).toEqual([])
  })

  it('rejects an empty array', () => {
    const r = buildShareCards([])
    expect(r.error).toBeTruthy()
  })

  it('rejects more than the max', () => {
    const many = Array.from({ length: MAX_SHARE_ITEMS + 1 }, (_, i) => ({ title: `t${i}` }))
    const r = buildShareCards(many)
    expect(r.error).toMatch(/at most/i)
  })

  it('accepts exactly the max', () => {
    const many = Array.from({ length: MAX_SHARE_ITEMS }, (_, i) => ({ title: `t${i}` }))
    const r = buildShareCards(many)
    expect(r.error).toBeNull()
    expect(r.cards).toHaveLength(MAX_SHARE_ITEMS)
  })

  it('defaults kind to client_message', () => {
    const r = buildShareCards([{ title: 'Hello' }])
    expect(r.error).toBeNull()
    expect(r.cards[0].kind).toBe('client_message')
  })

  it('keeps an explicit link kind', () => {
    const r = buildShareCards([{ kind: 'link', title: 'Subject line' }])
    expect(r.error).toBeNull()
    expect(r.cards[0].kind).toBe('link')
  })

  it('rejects an absolute/external url', () => {
    const r = buildShareCards([{ title: 'x', url: 'https://evil.example.com' }])
    expect(r.error).toMatch(/relative in-app url/i)
    expect(r.cards).toEqual([])
  })

  it('accepts a relative in-app url', () => {
    const r = buildShareCards([{ title: 'x', url: '/portal-chats?account=abc&message=1' }])
    expect(r.error).toBeNull()
    expect(r.cards[0].url).toBe('/portal-chats?account=abc&message=1')
  })

  it('rejects a card with an empty title (via validateTeamCard)', () => {
    const r = buildShareCards([{ title: '   ' }])
    expect(r.error).toMatch(/title/i)
  })

  it('rejects an invalid kind (via validateTeamCard)', () => {
    const r = buildShareCards([{ kind: 'bogus', title: 'x' }])
    expect(r.error).toMatch(/kind/i)
  })

  it('carries subtitle + entity back-reference through', () => {
    const r = buildShareCards([{
      kind: 'client_message',
      title: 'Acme LLC',
      subtitle: 'the client message body',
      url: '/portal-chats?account=a1&message=m1',
      entity_type: 'portal_message',
      entity_id: 'm1',
    }])
    expect(r.error).toBeNull()
    expect(r.cards[0]).toMatchObject({
      kind: 'client_message',
      title: 'Acme LLC',
      subtitle: 'the client message body',
      entity_type: 'portal_message',
      entity_id: 'm1',
    })
  })

  it('fails closed on the first bad item in a batch', () => {
    const r = buildShareCards([{ title: 'ok' }, { title: '' }, { title: 'ok2' }])
    expect(r.error).toBeTruthy()
    expect(r.cards).toEqual([])
  })
})

describe('composeShareMessage', () => {
  it('joins note and body with a blank line', () => {
    expect(composeShareMessage('my note', 'the email text')).toBe('my note\n\nthe email text')
  })

  it('returns just the note when body is empty', () => {
    expect(composeShareMessage('my note', '')).toBe('my note')
    expect(composeShareMessage('my note', null)).toBe('my note')
  })

  it('returns just the body when note is empty', () => {
    expect(composeShareMessage('', 'the email text')).toBe('the email text')
    expect(composeShareMessage(undefined, 'the email text')).toBe('the email text')
  })

  it('returns empty string when both are empty', () => {
    expect(composeShareMessage('', '')).toBe('')
    expect(composeShareMessage(null, null)).toBe('')
  })

  it('trims each part', () => {
    expect(composeShareMessage('  note  ', '  body  ')).toBe('note\n\nbody')
  })

  it('caps an over-long body and appends a truncation marker', () => {
    const long = 'x'.repeat(SHARE_BODY_CAP + 500)
    const out = composeShareMessage('', long)
    expect(out.length).toBeLessThan(long.length)
    expect(out).toMatch(/truncated — open the original/i)
    expect(out.startsWith('x'.repeat(100))).toBe(true)
  })

  it('does not truncate a body at exactly the cap', () => {
    const exact = 'y'.repeat(SHARE_BODY_CAP)
    const out = composeShareMessage('', exact)
    expect(out).toBe(exact)
    expect(out).not.toMatch(/truncated/i)
  })
})
