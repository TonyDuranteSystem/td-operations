import { describe, it, expect } from 'vitest'
import type { PortalMessage } from '@/lib/types'

// Mirror of the topics derivation in use-portal-chat.ts
function deriveTopics(messages: Pick<PortalMessage, 'topic'>[]): string[] {
  return Array.from(
    new Set(messages.map(m => m.topic).filter((t): t is string => !!t))
  ).sort()
}

// Mirror of the notification throttle key in notifications.ts
function throttleKey(topic: string | null | undefined, baseKey: string): string {
  return topic ? `${topic}::${baseKey}` : baseKey
}

// Mirror of the topic sanitization in the POST route
function sanitizeTopic(raw: unknown): string | null {
  if (typeof raw === 'string' && raw.trim()) return raw.trim().slice(0, 100)
  return null
}

describe('portal chat — topics', () => {
  describe('deriveTopics', () => {
    it('returns empty array when no messages have topics', () => {
      const msgs = [{ topic: null }, { topic: undefined }, { topic: null }]
      expect(deriveTopics(msgs)).toEqual([])
    })

    it('returns sorted unique topics', () => {
      const msgs = [
        { topic: 'Burlington' },
        { topic: 'Lien #3920' },
        { topic: 'Burlington' },
        { topic: null },
      ]
      expect(deriveTopics(msgs)).toEqual(['Burlington', 'Lien #3920'])
    })

    it('ignores empty strings (filtered as falsy)', () => {
      const msgs = [{ topic: '' }, { topic: 'Tax' }]
      expect(deriveTopics(msgs)).toEqual(['Tax'])
    })
  })

  describe('throttleKey', () => {
    it('uses baseKey alone when topic is null (backward-compatible)', () => {
      expect(throttleKey(null, 'contact-uuid')).toBe('contact-uuid')
    })

    it('uses baseKey alone when topic is undefined', () => {
      expect(throttleKey(undefined, 'account-uuid')).toBe('account-uuid')
    })

    it('prefixes topic when set — different topics produce different keys', () => {
      const base = 'contact-uuid'
      const k1 = throttleKey('Burlington', base)
      const k2 = throttleKey('Lien #3920', base)
      expect(k1).toBe('Burlington::contact-uuid')
      expect(k2).toBe('Lien #3920::contact-uuid')
      expect(k1).not.toBe(k2)
    })

    it('same topic + different base = different keys', () => {
      const k1 = throttleKey('Burlington', 'contact-a')
      const k2 = throttleKey('Burlington', 'contact-b')
      expect(k1).not.toBe(k2)
    })
  })

  describe('sanitizeTopic (POST route)', () => {
    it('returns null for null input', () => {
      expect(sanitizeTopic(null)).toBeNull()
    })

    it('returns null for empty string', () => {
      expect(sanitizeTopic('')).toBeNull()
    })

    it('returns null for whitespace-only', () => {
      expect(sanitizeTopic('   ')).toBeNull()
    })

    it('trims surrounding whitespace', () => {
      expect(sanitizeTopic('  Burlington  ')).toBe('Burlington')
    })

    it('truncates to 100 chars', () => {
      const long = 'A'.repeat(150)
      expect(sanitizeTopic(long)).toHaveLength(100)
    })

    it('returns null for non-string', () => {
      expect(sanitizeTopic(42)).toBeNull()
      expect(sanitizeTopic({})).toBeNull()
    })
  })
})
