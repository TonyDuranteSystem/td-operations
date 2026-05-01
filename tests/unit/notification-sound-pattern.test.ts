import { describe, it, expect } from 'vitest'
import { senderPatternIndex } from '@/lib/hooks/use-notification-sound'

describe('senderPatternIndex', () => {
  it('returns a number in [0, 4]', () => {
    const ids = [
      'abc123',
      '00000000-0000-0000-0000-000000000000',
      'user-antonio',
      'user-luca',
      '',
    ]
    for (const id of ids) {
      const idx = senderPatternIndex(id)
      expect(idx).toBeGreaterThanOrEqual(0)
      expect(idx).toBeLessThan(5)
    }
  })

  it('is deterministic — same input always returns same output', () => {
    const id = 'test-sender-id-xyz'
    expect(senderPatternIndex(id)).toBe(senderPatternIndex(id))
    expect(senderPatternIndex(id)).toBe(senderPatternIndex(id))
  })

  it('gives different senders different patterns most of the time', () => {
    const senders = ['antonio', 'luca', 'maria', 'giuseppe', 'sara', 'marco', 'elena', 'davide']
    const patterns = senders.map(senderPatternIndex)
    const unique = new Set(patterns)
    // With 8 senders and 5 patterns, we expect some variety (at least 2 distinct values)
    expect(unique.size).toBeGreaterThanOrEqual(2)
  })
})
