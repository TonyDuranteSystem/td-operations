import { describe, it, expect } from 'vitest'
import { combineHistory, earlierCursor, mergeEarlier, slidOutOfWindow, EARLIER_PAGE, MAX_JUMP_PAGES } from '@/lib/talk/earlier'
import type { TalkMessage } from '@/lib/talk/chat-model'

const msg = (id: string, minute: number, extra: Partial<TalkMessage> = {}): TalkMessage => ({
  id, sender_id: 'u', sender_name: 'U', message: id, created_at: new Date(Date.UTC(2026, 10, 3, 12, minute)).toISOString(), ...extra,
})

describe('load earlier messages', () => {
  it('adds an older page in front, oldest first, each message once', () => {
    const loaded = [msg('c', 30), msg('d', 40)]
    const page = [msg('a', 10), msg('b', 20), msg('c', 30)]
    expect(mergeEarlier(loaded, page).map(m => m.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('keeps older pages when the live window refreshes, and shows an overlap once from the live window', () => {
    const older = [msg('a', 10), msg('b', 20), msg('c', 30, { message: 'old copy' })]
    const live = [msg('c', 30, { message: 'edited copy' }), msg('d', 40), msg('e', 50)]
    const shown = combineHistory(older, live)
    expect(shown.map(m => m.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(shown.find(m => m.id === 'c')?.message).toBe('edited copy')
  })

  it('is just the live window when nothing older was loaded', () => {
    const live = [msg('x', 5)]
    expect(combineHistory([], live)).toBe(live)
  })

  it('asks for messages before the OLDEST one on screen, with its own untouched time', () => {
    const t = '2026-11-03T12:10:00.123456+00:00'
    const shown = [msg('b', 20), msg('a', 10, { created_at: t }), msg('w', 1, { local: { state: 'waiting', files: [] } })]
    expect(earlierCursor(shown)).toBe(t)
  })

  it('has no cursor for an empty chat', () => {
    expect(earlierCursor([])).toBeNull()
  })

  it('page and jump limits are sensible', () => {
    expect(EARLIER_PAGE).toBeGreaterThan(0)
    expect(MAX_JUMP_PAGES * EARLIER_PAGE).toBeGreaterThanOrEqual(2000)
  })

  it('a message that slid out of the live window is kept (older than the window, newer than the older pages)', () => {
    const prevWindow = [msg('m1', 10), msg('m2', 20), msg('m3', 30), msg('m4', 40)]
    const snapshot = [msg('m2', 20), msg('m3', 30), msg('m4', 40), msg('m5', 50)] // m1 was pushed out by m5
    const slid = slidOutOfWindow(prevWindow, snapshot)
    expect(slid.map(m => m.id)).toEqual(['m1'])
    // with the older pages (m-1 and earlier) the screen then has no hole: ... older, m1, m2 ...
    const older = [msg('o1', 1), msg('o2', 5)]
    expect(combineHistory(mergeEarlier(older, slid), snapshot).map(m => m.id)).toEqual(['o1', 'o2', 'm1', 'm2', 'm3', 'm4', 'm5'])
  })

  it('does not keep waiting messages, messages still in the snapshot, or anything newer than the snapshot', () => {
    const prevWindow = [msg('a', 10), msg('w', 5, { local: { state: 'waiting', files: [] } }), msg('z', 90)]
    const snapshot = [msg('a', 10), msg('b', 20)]
    expect(slidOutOfWindow(prevWindow, snapshot)).toEqual([])
    expect(slidOutOfWindow(prevWindow, [])).toEqual([])
  })
})
