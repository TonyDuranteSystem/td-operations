import { describe, it, expect } from 'vitest'
import {
  isValidReactionEmoji,
  summarizeReactions,
  REACTION_EMOJI_MAX_LEN,
  type MessageReaction,
} from '@/lib/portal/reactions'

function r(emoji: string, reactor_id: string, type: 'client' | 'staff', name: string | null = null): MessageReaction {
  return { emoji, reactor_id, reactor_type: type, reactor_name: name, created_at: '2026-06-30T12:00:00Z' }
}

describe('isValidReactionEmoji', () => {
  it('accepts common single emojis', () => {
    expect(isValidReactionEmoji('👍')).toBe(true)
    expect(isValidReactionEmoji('❤️')).toBe(true)
    expect(isValidReactionEmoji('🎉')).toBe(true)
  })
  it('accepts ZWJ sequences (one glyph, many code points)', () => {
    expect(isValidReactionEmoji('👨‍👩‍👧‍👦')).toBe(true)
    expect(isValidReactionEmoji('🧑🏽‍💻')).toBe(true)
  })
  it('rejects empty / whitespace-padded / non-emoji strings', () => {
    expect(isValidReactionEmoji('')).toBe(false)
    expect(isValidReactionEmoji('   ')).toBe(false)
    expect(isValidReactionEmoji(' 👍')).toBe(false) // surrounding whitespace
    expect(isValidReactionEmoji('lol')).toBe(false)
    expect(isValidReactionEmoji('123')).toBe(false)
    expect(isValidReactionEmoji(':thumbsup:')).toBe(false)
  })
  it('rejects non-strings and over-length input', () => {
    expect(isValidReactionEmoji(null)).toBe(false)
    expect(isValidReactionEmoji(undefined)).toBe(false)
    expect(isValidReactionEmoji(42)).toBe(false)
    expect(isValidReactionEmoji('👍'.repeat(REACTION_EMOJI_MAX_LEN + 1))).toBe(false)
  })
})

describe('summarizeReactions', () => {
  it('returns [] for empty / null / non-array', () => {
    expect(summarizeReactions([], 'me')).toEqual([])
    expect(summarizeReactions(null, 'me')).toEqual([])
    expect(summarizeReactions(undefined, 'me')).toEqual([])
    // @ts-expect-error defensive: non-array input
    expect(summarizeReactions('nope', 'me')).toEqual([])
  })

  it('groups by emoji with correct counts and first-seen order', () => {
    const groups = summarizeReactions([
      r('👍', 'a', 'client', 'Ann'),
      r('🎉', 'b', 'client', 'Bob'),
      r('👍', 'c', 'client', 'Cy'),
    ], null)
    expect(groups.map(g => g.emoji)).toEqual(['👍', '🎉'])
    expect(groups[0]).toMatchObject({ emoji: '👍', count: 2 })
    expect(groups[1]).toMatchObject({ emoji: '🎉', count: 1 })
  })

  it('flags "mine" when viewer is among reactors of that emoji', () => {
    const groups = summarizeReactions([
      r('👍', 'me', 'client', 'Me'),
      r('👍', 'other', 'client', 'Other'),
      r('🔥', 'other', 'client', 'Other'),
    ], 'me')
    expect(groups.find(g => g.emoji === '👍')!.mine).toBe(true)
    expect(groups.find(g => g.emoji === '🔥')!.mine).toBe(false)
  })

  it('uses staff fallback label when a staff reactor has no name', () => {
    const groups = summarizeReactions([r('👍', 's1', 'staff', null)], null, 'Team')
    expect(groups[0].names).toEqual(['Team'])
  })

  it('uses contact name and drops null client names', () => {
    const groups = summarizeReactions([
      r('👍', 'a', 'client', 'Ann'),
      r('👍', 'b', 'client', null),
    ], null)
    expect(groups[0].count).toBe(2)
    expect(groups[0].names).toEqual(['Ann']) // null client name dropped
  })

  it('ignores malformed entries without throwing', () => {
    const groups = summarizeReactions([
      // @ts-expect-error missing emoji
      { reactor_id: 'x', reactor_type: 'client', reactor_name: null, created_at: 'z' },
      r('👍', 'a', 'client', 'Ann'),
    ], null)
    expect(groups).toHaveLength(1)
    expect(groups[0].emoji).toBe('👍')
  })
})
