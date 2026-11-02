import { describe, it, expect } from 'vitest'
import { upcomingCallsFirst } from '@/lib/leads/list-filters'

const L = (id: string, call_date: string | null) => ({ id, call_date })
const ids = (xs: { id: string }[]) => xs.map(x => x.id).join(',')

describe('upcomingCallsFirst', () => {
  it('puts calls from today on, soonest first, then the rest in their old order', () => {
    // incoming order = newest lead first (as the page fetches)
    const rows = [L('a', '2026-10-13'), L('b', '2026-11-05'), L('c', null), L('d', '2026-11-02'), L('e', '2026-10-05'), L('f', '2026-11-02')]
    expect(ids(upcomingCallsFirst(rows, '2026-11-02'))).toBe('d,f,b,a,c,e')
  })
  it('a call today counts as upcoming; yesterday does not', () => {
    expect(ids(upcomingCallsFirst([L('x', '2026-11-01'), L('y', '2026-11-02')], '2026-11-02'))).toBe('y,x')
  })
  it('handles a timestamp call date by its day', () => {
    expect(ids(upcomingCallsFirst([L('x', '2026-11-01T15:00:00Z'), L('y', '2026-11-02T15:00:00Z')], '2026-11-02'))).toBe('y,x')
  })
  it('never drops or duplicates a row, and does not change the input', () => {
    const rows = [L('a', null), L('b', '2026-12-01'), L('c', '2026-01-01')]
    const copy = [...rows]
    const out = upcomingCallsFirst(rows, '2026-11-02')
    expect(out).toHaveLength(3)
    expect(new Set(out.map(r => r.id)).size).toBe(3)
    expect(rows).toEqual(copy)
  })
  it('empty and all-past lists come back unchanged', () => {
    expect(upcomingCallsFirst([], '2026-11-02')).toEqual([])
    const past = [L('a', '2026-10-01'), L('b', null)]
    expect(ids(upcomingCallsFirst(past, '2026-11-02'))).toBe('a,b')
  })
})
