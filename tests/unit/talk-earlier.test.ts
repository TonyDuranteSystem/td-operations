import { describe, it, expect } from 'vitest'
import { combineHistory, earlierCursor, mergeEarlier, EARLIER_PAGE, MAX_JUMP_PAGES } from '@/lib/talk/earlier'
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
})
