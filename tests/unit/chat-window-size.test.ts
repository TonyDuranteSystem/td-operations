/**
 * Floating chat window size — clamping and stored-value handling.
 *
 * Sibling of chat-window-position.test.ts. Antonio, 2026-09-08: "I already
 * told you to fix the page. I can't resize it" — the window was hardcoded to
 * a single fixed size with no resize handle at all.
 */
import { describe, it, expect } from 'vitest'
import {
  clampChatWindowSize,
  readStoredChatWindowSize,
  serializeChatWindowSize,
  CHAT_WINDOW_DEFAULT_SIZE,
  CHAT_WINDOW_MIN_SIZE,
  CHAT_WINDOW_MAX_SIZE,
  CHAT_WINDOW_SIZE_KEY,
} from '@/lib/team/chat-window-size'
import { CHAT_WINDOW_POS_KEY } from '@/lib/team/chat-window-position'

const DESKTOP = { vw: 1440, vh: 900 }

describe('clampChatWindowSize', () => {
  it('leaves a size that is already within bounds alone', () => {
    expect(clampChatWindowSize({ w: 420, h: 560 }, DESKTOP)).toEqual({ w: 420, h: 560 })
  })

  it('never shrinks below the usable floor', () => {
    expect(clampChatWindowSize({ w: 50, h: 20 }, DESKTOP)).toEqual(CHAT_WINDOW_MIN_SIZE)
  })

  it('never exceeds the absolute ceiling even on a huge screen', () => {
    const size = clampChatWindowSize({ w: 5000, h: 5000 }, { vw: 4000, vh: 3000 })
    expect(size.w).toBeLessThanOrEqual(CHAT_WINDOW_MAX_SIZE.w)
    expect(size.h).toBeLessThanOrEqual(CHAT_WINDOW_MAX_SIZE.h)
  })

  it('shrinks to fit a smaller viewport rather than hanging off screen — the cross-device case position solves with fractions, size solves by re-clamping', () => {
    // A size stored on a big iMac, read back on a much smaller laptop screen.
    const size = clampChatWindowSize({ w: 640, h: 800 }, { vw: 900, vh: 700 })
    expect(size.w).toBeLessThan(900)
    expect(size.h).toBeLessThan(700)
  })

  it('never returns an inverted range even when the viewport is tiny', () => {
    const size = clampChatWindowSize({ w: 300, h: 300 }, { vw: 200, vh: 200 })
    expect(size.w).toBeGreaterThanOrEqual(CHAT_WINDOW_MIN_SIZE.w)
    expect(size.h).toBeGreaterThanOrEqual(CHAT_WINDOW_MIN_SIZE.h)
  })

  it('survives NaN, Infinity and missing values instead of throwing', () => {
    expect(clampChatWindowSize({ w: NaN, h: Infinity }, DESKTOP)).toEqual(CHAT_WINDOW_MIN_SIZE)
    // @ts-expect-error — deliberately malformed input from stale storage
    expect(() => clampChatWindowSize(undefined, DESKTOP)).not.toThrow()
  })

  it('ignores a zero or non-finite viewport rather than guessing — falls back to the absolute ceiling', () => {
    const size = clampChatWindowSize({ w: 500, h: 600 }, { vw: 0, vh: 0 })
    expect(size).toEqual({ w: 500, h: 600 })
  })

  it('skips the viewport half of the clamp when no viewport is given at all (SSR / first paint)', () => {
    expect(clampChatWindowSize({ w: 500, h: 600 })).toEqual({ w: 500, h: 600 })
  })
})

describe('readStoredChatWindowSize', () => {
  it('returns the default for absent or empty storage', () => {
    expect(readStoredChatWindowSize(null)).toEqual(CHAT_WINDOW_DEFAULT_SIZE)
    expect(readStoredChatWindowSize(undefined)).toEqual(CHAT_WINDOW_DEFAULT_SIZE)
    expect(readStoredChatWindowSize('')).toEqual(CHAT_WINDOW_DEFAULT_SIZE)
  })

  it('returns the default for garbage rather than throwing', () => {
    expect(readStoredChatWindowSize('not json')).toEqual(CHAT_WINDOW_DEFAULT_SIZE)
    expect(readStoredChatWindowSize('null')).toEqual(CHAT_WINDOW_DEFAULT_SIZE)
    expect(readStoredChatWindowSize('[1,2]')).toEqual(CHAT_WINDOW_DEFAULT_SIZE)
    expect(readStoredChatWindowSize('{"w":"wide","h":2}')).toEqual(CHAT_WINDOW_DEFAULT_SIZE)
    expect(readStoredChatWindowSize('{"w":500}')).toEqual(CHAT_WINDOW_DEFAULT_SIZE)
  })

  it('round-trips a real size', () => {
    const size = { w: 480, h: 640 }
    expect(readStoredChatWindowSize(serializeChatWindowSize(size))).toEqual(size)
  })

  it('does NOT share the position or notes storage key', () => {
    expect(CHAT_WINDOW_SIZE_KEY).not.toBe(CHAT_WINDOW_POS_KEY)
    expect(CHAT_WINDOW_SIZE_KEY).not.toBe('td-sticky-note-pos-v1')
  })
})
