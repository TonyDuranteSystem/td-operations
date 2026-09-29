import { describe, it, expect } from 'vitest'
import { mergeRefreshedMessages, parseTimestamp, sortMessagesAscending } from '@/lib/portal/chat-refresh-merge'

const m = (id: string, minute: number) => ({ id, created_at: `2026-09-28T20:${String(minute).padStart(2, '0')}:00.123456+00:00` })
const ids = (list: { id: string }[]) => list.map(x => x.id)

describe('mergeRefreshedMessages', () => {
  it('keeps a staff message that arrived live after the refetch snapshot (the reported symptom)', () => {
    const held = [m('a', 1), m('b', 2), m('live', 5)]
    const fetched = [m('a', 1), m('b', 2)] // snapshot taken before 'live' was inserted
    const r = mergeRefreshedMessages({ fetched, held, limit: 50, liveIds: new Set(['live']) })
    expect(ids(r.messages)).toEqual(['a', 'b', 'live'])
  })

  it("keeps the client's own just-sent message", () => {
    const held = [m('a', 1), m('mine', 3)]
    const r = mergeRefreshedMessages({ fetched: [m('a', 1)], held, limit: 50, liveIds: new Set(['mine']) })
    expect(ids(r.messages)).toEqual(['a', 'mine'])
  })

  it('drops an in-window message missing from the response (soft-deleted while offline, R100)', () => {
    const held = [m('a', 1), m('deleted', 2), m('c', 3)]
    const r = mergeRefreshedMessages({ fetched: [m('a', 1), m('c', 3)], held, limit: 50, liveIds: new Set() })
    expect(ids(r.messages)).toEqual(['a', 'c'])
  })

  it('keeps paged-back history older than a FULL window', () => {
    const held = [m('old1', 1), m('old2', 2), m('w1', 10), m('w2', 11)]
    const r = mergeRefreshedMessages({ fetched: [m('w1', 10), m('w2', 11)], held, limit: 2, liveIds: new Set() })
    expect(ids(r.messages)).toEqual(['old1', 'old2', 'w1', 'w2'])
    expect(r.windowFull).toBe(true)
    expect(r.keptOlder).toBe(2)
  })

  it('drops older held rows when the window was NOT full (whole thread fetched → they were deleted)', () => {
    const held = [m('gone', 1), m('w1', 10)]
    const r = mergeRefreshedMessages({ fetched: [m('w1', 10)], held, limit: 50, liveIds: new Set() })
    expect(ids(r.messages)).toEqual(['w1'])
  })

  it('an empty response clears everything except live arrivals', () => {
    const r = mergeRefreshedMessages({ fetched: [], held: [m('a', 1), m('live', 2)], limit: 50, liveIds: new Set(['live']) })
    expect(ids(r.messages)).toEqual(['live'])
  })

  it('prefers the fetched copy of a message (server truth for edits) and never duplicates', () => {
    const held = [{ ...m('a', 1), text: 'old' }]
    const fetched = [{ ...m('a', 1), text: 'edited' }]
    const r = mergeRefreshedMessages({ fetched, held, limit: 50, liveIds: new Set(['a']) })
    expect(r.messages).toEqual([{ ...m('a', 1), text: 'edited' }])
  })

  it('returns ascending order even when the response is newest-first', () => {
    const r = mergeRefreshedMessages({ fetched: [m('c', 3), m('a', 1), m('b', 2)], held: [], limit: 50, liveIds: new Set() })
    expect(ids(r.messages)).toEqual(['a', 'b', 'c'])
  })
})

describe('mergeRefreshedMessages — review round fixes', () => {
  it('drops a message soft-deleted DURING the fetch even though the older snapshot still has it (R100)', () => {
    const held = [m('a', 1), m('c', 3)] // X already removed from screen by the realtime delete
    const fetched = [m('a', 1), m('x', 2), m('c', 3)]
    const r = mergeRefreshedMessages({ fetched, held, limit: 50, liveIds: new Set(), deletedIds: new Set(['x']) })
    expect(ids(r.messages)).toEqual(['a', 'c'])
  })

  it('no overlap after a burst bigger than the window: drops old rows instead of leaving a hidden gap', () => {
    const held = [m('old1', 1), m('old2', 2)]
    const fetched = [m('n1', 30), m('n2', 31)] // limit 2, full, shares nothing with held
    const r = mergeRefreshedMessages({ fetched, held, limit: 2, liveIds: new Set() })
    expect(ids(r.messages)).toEqual(['n1', 'n2'])
    expect(r.droppedForGap).toBe(true)
    expect(r.keptOlder).toBe(0)
  })

  it('with overlap, older paged history is kept and no gap is reported', () => {
    const held = [m('old1', 1), m('w1', 10)]
    const fetched = [m('w1', 10), m('w2', 11)]
    const r = mergeRefreshedMessages({ fetched, held, limit: 2, liveIds: new Set() })
    expect(ids(r.messages)).toEqual(['old1', 'w1', 'w2'])
    expect(r.droppedForGap).toBe(false)
  })
})

describe('sortMessagesAscending', () => {
  it('orders by time, then by the raw microsecond string when the millisecond is equal', () => {
    const x = { id: 'x', created_at: '2026-09-28T20:41:17.432385+00:00' }
    const y = { id: 'y', created_at: '2026-09-28T20:41:17.432001+00:00' }
    expect(ids(sortMessagesAscending([x, y]))).toEqual(['y', 'x'])
  })

  it('does not mutate its input', () => {
    const list = [m('b', 2), m('a', 1)]
    sortMessagesAscending(list)
    expect(ids(list)).toEqual(['b', 'a'])
  })
})

describe('parseTimestamp (Safari-safe)', () => {
  it('parses ISO, space-separated and short-offset Postgres forms to the same instant (ms)', () => {
    const iso = parseTimestamp('2026-09-29T10:00:00.123456+00:00')
    expect(iso).toBe(Date.UTC(2026, 8, 29, 10, 0, 0, 123))
    expect(parseTimestamp('2026-09-29 10:00:00.123456+00')).toBe(iso)
    expect(parseTimestamp('2026-09-29T10:00:00.123Z')).toBe(iso)
  })
  it('returns 0 for empty or garbage', () => {
    expect(parseTimestamp('')).toBe(0)
    expect(parseTimestamp(null)).toBe(0)
    expect(parseTimestamp('not a date')).toBe(0)
  })
})
