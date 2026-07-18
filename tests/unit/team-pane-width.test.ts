import { describe, it, expect } from 'vitest'
import {
  clampThreadPaneWidth,
  readStoredThreadPaneWidth,
  THREAD_PANE_DEFAULT_WIDTH,
  THREAD_PANE_MIN_WIDTH,
  THREAD_STREAM_MIN_WIDTH,
} from '@/lib/team/pane-width'

describe('clampThreadPaneWidth', () => {
  const WIDE = 1600

  it('keeps a sensible width untouched', () => {
    expect(clampThreadPaneWidth(600, WIDE)).toBe(600)
  })

  it('never goes below the pane floor', () => {
    expect(clampThreadPaneWidth(10, WIDE)).toBe(THREAD_PANE_MIN_WIDTH)
    expect(clampThreadPaneWidth(-500, WIDE)).toBe(THREAD_PANE_MIN_WIDTH)
    expect(clampThreadPaneWidth(0, WIDE)).toBe(THREAD_PANE_MIN_WIDTH)
  })

  it('leaves room for the channel stream', () => {
    expect(clampThreadPaneWidth(5000, WIDE)).toBe(WIDE - THREAD_STREAM_MIN_WIDTH)
  })

  it('lets the pane floor win when the container cannot honour both', () => {
    // 500px container: stream floor would demand a 140px pane — unreachable.
    expect(clampThreadPaneWidth(400, 500)).toBe(THREAD_PANE_MIN_WIDTH)
  })

  it('skips the stream floor when the container is unknown', () => {
    expect(clampThreadPaneWidth(900, 0)).toBe(900)
    expect(clampThreadPaneWidth(900, Number.NaN)).toBe(900)
    expect(clampThreadPaneWidth(900, Number.POSITIVE_INFINITY)).toBe(900)
  })

  it('falls back to the default for a non-finite width', () => {
    expect(clampThreadPaneWidth(Number.NaN, WIDE)).toBe(THREAD_PANE_DEFAULT_WIDTH)
    expect(clampThreadPaneWidth(Number.POSITIVE_INFINITY, 0)).toBe(THREAD_PANE_DEFAULT_WIDTH)
  })

  it('returns whole pixels', () => {
    expect(clampThreadPaneWidth(600.7, WIDE)).toBe(601)
  })
})

describe('readStoredThreadPaneWidth', () => {
  it('reads a stored width back', () => {
    expect(readStoredThreadPaneWidth('720')).toBe(720)
  })

  it('defaults when nothing is stored', () => {
    expect(readStoredThreadPaneWidth(null)).toBe(THREAD_PANE_DEFAULT_WIDTH)
    expect(readStoredThreadPaneWidth(undefined)).toBe(THREAD_PANE_DEFAULT_WIDTH)
    expect(readStoredThreadPaneWidth('')).toBe(THREAD_PANE_DEFAULT_WIDTH)
  })

  it('survives a garbage or hand-edited key', () => {
    expect(readStoredThreadPaneWidth('wide please')).toBe(THREAD_PANE_DEFAULT_WIDTH)
    expect(readStoredThreadPaneWidth('-40')).toBe(THREAD_PANE_DEFAULT_WIDTH)
    expect(readStoredThreadPaneWidth('null')).toBe(THREAD_PANE_DEFAULT_WIDTH)
  })

  it('clamps a stored width that is below the floor', () => {
    expect(readStoredThreadPaneWidth('80')).toBe(THREAD_PANE_MIN_WIDTH)
  })
})
