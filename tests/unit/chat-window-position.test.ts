/**
 * Floating chat window position — clamping and stored-value handling.
 *
 * The cases here are the concrete bugs the council found in reusing the notes
 * position module: a fixed 0.92 cap pushing a ~360px window's composer off
 * screen, and garbage storage breaking the chat.
 */
import { describe, it, expect } from 'vitest'
import {
  clampChatWindowPos,
  readStoredChatWindowPos,
  serializeChatWindowPos,
  CHAT_WINDOW_DEFAULT_POS,
  CHAT_WINDOW_POS_KEY,
} from '@/lib/team/chat-window-position'

const DESKTOP = { vw: 1440, vh: 900, w: 360, h: 480 }

describe('clampChatWindowPos', () => {
  it('leaves a position that is already fully on screen alone', () => {
    expect(clampChatWindowPos({ x: 0.5, y: 0.2 }, DESKTOP)).toEqual({ x: 0.5, y: 0.2 })
  })

  it('keeps the whole window on screen when dragged to the far corner', () => {
    const pos = clampChatWindowPos({ x: 1, y: 1 }, DESKTOP)
    // the last legal left edge is viewport - element
    expect(pos.x * DESKTOP.vw + DESKTOP.w).toBeLessThanOrEqual(DESKTOP.vw)
    expect(pos.y * DESKTOP.vh + DESKTOP.h).toBeLessThanOrEqual(DESKTOP.vh)
  })

  it('THE NOTES-MODULE BUG: a 0.92-style cap would push the composer off screen; this does not', () => {
    // What note-position would have produced for a 360px window on a 1440px screen.
    const noteStyleLeftEdge = 0.92 * DESKTOP.vw
    expect(noteStyleLeftEdge + DESKTOP.w).toBeGreaterThan(DESKTOP.vw) // proves the old cap is broken
    const pos = clampChatWindowPos({ x: 0.92, y: 0.92 }, DESKTOP)
    expect(pos.x * DESKTOP.vw + DESKTOP.w).toBeLessThanOrEqual(DESKTOP.vw)
  })

  it('never returns a negative fraction', () => {
    const pos = clampChatWindowPos({ x: -5, y: -0.3 }, DESKTOP)
    expect(pos).toEqual({ x: 0, y: 0 })
  })

  it('pins to the corner when the window is larger than the viewport', () => {
    // a tall window on a short phone: showing the top-left is the only sane answer
    const pos = clampChatWindowPos({ x: 0.5, y: 0.5 }, { vw: 380, vh: 500, w: 420, h: 700 })
    expect(pos).toEqual({ x: 0, y: 0 })
  })

  it('clamps to 0..1 when the element has not been measured yet', () => {
    expect(clampChatWindowPos({ x: 0.4, y: 0.4 })).toEqual({ x: 0.4, y: 0.4 })
    expect(clampChatWindowPos({ x: 3, y: 3 })).toEqual({ x: 1, y: 1 })
  })

  it('survives NaN, Infinity and missing values instead of throwing', () => {
    expect(clampChatWindowPos({ x: NaN, y: Infinity }, DESKTOP)).toEqual({ x: 0, y: 0 })
    // @ts-expect-error — deliberately malformed input from stale storage
    expect(() => clampChatWindowPos(undefined, DESKTOP)).not.toThrow()
  })

  it('ignores a zero or non-finite viewport rather than guessing', () => {
    const pos = clampChatWindowPos({ x: 0.5, y: 0.5 }, { vw: 0, vh: 0, w: 360, h: 480 })
    expect(pos).toEqual({ x: 0.5, y: 0.5 })
  })
})

describe('readStoredChatWindowPos', () => {
  it('returns the default for absent or empty storage', () => {
    expect(readStoredChatWindowPos(null)).toEqual(CHAT_WINDOW_DEFAULT_POS)
    expect(readStoredChatWindowPos(undefined)).toEqual(CHAT_WINDOW_DEFAULT_POS)
    expect(readStoredChatWindowPos('')).toEqual(CHAT_WINDOW_DEFAULT_POS)
  })

  it('returns the default for garbage rather than throwing', () => {
    expect(readStoredChatWindowPos('not json')).toEqual(CHAT_WINDOW_DEFAULT_POS)
    expect(readStoredChatWindowPos('null')).toEqual(CHAT_WINDOW_DEFAULT_POS)
    expect(readStoredChatWindowPos('[1,2]')).toEqual(CHAT_WINDOW_DEFAULT_POS)
    expect(readStoredChatWindowPos('{"x":"left","y":2}')).toEqual(CHAT_WINDOW_DEFAULT_POS)
    expect(readStoredChatWindowPos('{"x":1}')).toEqual(CHAT_WINDOW_DEFAULT_POS)
  })

  it('round-trips a real position', () => {
    const pos = { x: 0.33, y: 0.66 }
    expect(readStoredChatWindowPos(serializeChatWindowPos(pos))).toEqual(pos)
  })

  it('does NOT share the notes storage key', () => {
    // The notes layer prunes its map to live note ids on every refetch; sharing
    // the key would delete the window's position within ~60 seconds.
    expect(CHAT_WINDOW_POS_KEY).not.toBe('td-sticky-note-pos-v1')
  })
})
