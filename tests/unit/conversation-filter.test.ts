import { describe, it, expect } from 'vitest'
import { matchesConversationFilter } from '@/lib/team/conversation-filter'

describe('matchesConversationFilter', () => {
  const open = { topic: 'Billing', resolution: null }
  const solved = { topic: 'Billing', resolution: 'solved' as const }
  const closed = { topic: 'Tax', resolution: 'closed' as const }

  it('no filters → everything passes', () => {
    for (const t of [open, solved, closed]) {
      expect(matchesConversationFilter(t, { topic: '', state: 'all' })).toBe(true)
    }
  })

  it('topic filter matches exact topic only', () => {
    expect(matchesConversationFilter(open, { topic: 'Billing', state: 'all' })).toBe(true)
    expect(matchesConversationFilter(closed, { topic: 'Billing', state: 'all' })).toBe(false)
  })

  it('state open = no resolution', () => {
    expect(matchesConversationFilter(open, { topic: '', state: 'open' })).toBe(true)
    expect(matchesConversationFilter(solved, { topic: '', state: 'open' })).toBe(false)
    expect(matchesConversationFilter(closed, { topic: '', state: 'open' })).toBe(false)
  })

  it('state solved = solved only', () => {
    expect(matchesConversationFilter(solved, { topic: '', state: 'solved' })).toBe(true)
    expect(matchesConversationFilter(open, { topic: '', state: 'solved' })).toBe(false)
    expect(matchesConversationFilter(closed, { topic: '', state: 'solved' })).toBe(false)
  })

  it('state closed = closed only', () => {
    expect(matchesConversationFilter(closed, { topic: '', state: 'closed' })).toBe(true)
    expect(matchesConversationFilter(solved, { topic: '', state: 'closed' })).toBe(false)
  })

  it('topic + state combine (AND)', () => {
    expect(matchesConversationFilter(solved, { topic: 'Billing', state: 'solved' })).toBe(true)
    expect(matchesConversationFilter(solved, { topic: 'Tax', state: 'solved' })).toBe(false)
    expect(matchesConversationFilter(open, { topic: 'Billing', state: 'solved' })).toBe(false)
  })

  it('a topic-less conversation only matches the "all topics" filter', () => {
    const none = { topic: null, resolution: null }
    expect(matchesConversationFilter(none, { topic: '', state: 'all' })).toBe(true)
    expect(matchesConversationFilter(none, { topic: 'Billing', state: 'all' })).toBe(false)
  })
})
