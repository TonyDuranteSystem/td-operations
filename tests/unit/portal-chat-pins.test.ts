import { describe, it, expect } from 'vitest'
import { mergePins, pinSetChanged, PINS_LIMIT, PIN_JUMP_MAX_PAGES } from '@/lib/portal/pins'

type M = { id: string; pinned_at?: string | null; deleted_at?: string | null; message?: string }
const pin = (id: string, at: string, extra: Partial<M> = {}): M => ({ id, pinned_at: at, ...extra })
const plain = (id: string, extra: Partial<M> = {}): M => ({ id, pinned_at: null, ...extra })

describe('mergePins (what the Pinned strip shows)', () => {
  it('shows the pins the server returned even when their messages are not loaded, newest pin first', () => {
    const server = [pin('old', '2026-06-04T14:00:00Z'), pin('mid', '2026-09-22T00:00:00Z'), pin('new', '2026-11-12T17:00:00Z')]
    const live = [plain('x'), pin('new', '2026-11-12T17:00:00Z')]
    expect(mergePins(server, live, live).map(p => p.id)).toEqual(['new', 'mid', 'old'])
  })

  it('a message in the live window decides for itself: unpinned there → gone from the strip', () => {
    const server = [pin('a', '2026-11-01T00:00:00Z'), pin('b', '2026-11-02T00:00:00Z')]
    const live = [plain('a'), pin('b', '2026-11-02T00:00:00Z')]
    expect(mergePins(server, live, live).map(p => p.id)).toEqual(['b'])
  })

  it('a message just pinned in the live window shows at once, before the server list refreshes', () => {
    const live = [pin('fresh', '2026-11-17T10:00:00Z')]
    expect(mergePins([], live, live).map(p => p.id)).toEqual(['fresh'])
  })

  it('the fresher live copy replaces the server copy', () => {
    const server = [pin('a', '2026-11-01T00:00:00Z', { message: 'old text' })]
    const live = [pin('a', '2026-11-01T00:00:00Z', { message: 'edited text' })]
    expect(mergePins(server, live, live)[0].message).toBe('edited text')
  })

  it('never shows a deleted message, whichever side says so', () => {
    const server = [pin('a', '2026-11-01T00:00:00Z', { deleted_at: '2026-11-02T00:00:00Z' }), pin('b', '2026-11-03T00:00:00Z')]
    const live = [pin('b', '2026-11-03T00:00:00Z', { deleted_at: '2026-11-04T00:00:00Z' })]
    expect(mergePins(server, live, live)).toEqual([])
  })

  it('does not trust a stale copy from an older page that was opened earlier', () => {
    const server: M[] = []
    const live: M[] = []
    const loadedAll = [pin('stale', '2026-06-04T14:00:00Z')]
    expect(mergePins(server, live, loadedAll)).toEqual([])
  })

  it('with no server list yet, falls back to the pins in what is loaded', () => {
    const loadedAll = [plain('x'), pin('p1', '2026-06-04T14:00:00Z'), pin('p2', '2026-09-22T00:00:00Z'), pin('gone', '2026-10-01T00:00:00Z', { deleted_at: '2026-10-02T00:00:00Z' })]
    expect(mergePins(undefined, [], loadedAll).map(p => p.id)).toEqual(['p2', 'p1'])
  })
})

describe('pinSetChanged (when the strip must reload from the server)', () => {
  const current = [pin('a', '2026-11-01T00:00:00Z')]
  it('is true when an unlisted message becomes pinned', () => {
    expect(pinSetChanged(current, pin('b', '2026-11-05T00:00:00Z'))).toBe(true)
  })
  it('is true when a listed message is unpinned or deleted', () => {
    expect(pinSetChanged(current, plain('a'))).toBe(true)
    expect(pinSetChanged(current, pin('a', '2026-11-01T00:00:00Z', { deleted_at: '2026-11-06T00:00:00Z' }))).toBe(true)
  })
  it('is false for a read mark or an edit (no change in who is pinned)', () => {
    expect(pinSetChanged(current, pin('a', '2026-11-01T00:00:00Z'))).toBe(false)
    expect(pinSetChanged(current, plain('z'))).toBe(false)
  })
  it('is false while the list has not loaded', () => {
    expect(pinSetChanged(undefined, pin('b', '2026-11-05T00:00:00Z'))).toBe(false)
  })
})

describe('limits', () => {
  it('are sane', () => {
    expect(PINS_LIMIT).toBe(50)
    expect(PIN_JUMP_MAX_PAGES).toBeGreaterThanOrEqual(10)
  })
})
