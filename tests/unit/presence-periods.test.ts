/**
 * Presence-period detector (Phase 2b) — every fixture demanded by the dual
 * adversarial review: per-location overlapping runs, EU/country containment
 * merge, residence suppression, density floor (low never emitted), gap
 * merging, ISO-year boundary, all-manual periods, sweep-set scoping.
 */
import { describe, it, expect } from 'vitest'
import {
  detectPresencePeriods,
  isSweepableRow,
  PRESENCE_MIN_ROWS_PER_WEEK,
  PRESENCE_MIN_WEEKS,
  type LocatableRow,
} from '@/lib/tax/presence-periods'

// 2025-02-03 is a Monday — week w, row n lands on Monday+n days of that week.
const MONDAY0 = Date.UTC(2025, 1, 3)
const dateOf = (week: number, day = 0) =>
  new Date(MONDAY0 + (week * 7 + day) * 86400000).toISOString().slice(0, 10)

let seq = 0
const row = (week: number, loc: string, over: Partial<LocatableRow> = {}, day = 0): LocatableRow => ({
  id: `r${seq++}`,
  transaction_date: dateOf(week, day),
  description: over.description ?? `${loc} merchant ${seq % 4}`,
  counterparty: null,
  amount: -20,
  category: 'uncategorized',
  notes: null,
  loc_code: loc,
  ...over,
})

/** weeks of presence at floor density (or more) for one location. */
const weeksOf = (loc: string, fromWeek: number, toWeek: number, perWeek = PRESENCE_MIN_ROWS_PER_WEEK, over: Partial<LocatableRow> = {}) => {
  const rows: LocatableRow[] = []
  for (let w = fromWeek; w <= toWeek; w++) {
    for (let n = 0; n < perWeek; n++) rows.push(row(w, loc, over, n % 7))
  }
  return rows
}

describe('detectPresencePeriods — density floor and minimum length', () => {
  it('a dense multi-week stay is one period with correct counts', () => {
    const rows = weeksOf('IT', 0, 7, 3)
    const p = detectPresencePeriods(rows, null)
    expect(p).toHaveLength(1)
    expect(p[0].primary).toBe('IT')
    expect(p[0].loc_codes).toEqual(['IT'])
    expect(p[0].row_count).toBe(24)
    expect(p[0].sweepable_count).toBe(24)
    expect(p[0].start).toBe(dateOf(0))
    expect(p[0].confidence).toBe('high')
  })

  it('below-floor density is NEVER a period (the no-card-on-low property)', () => {
    const rows = weeksOf('IT', 0, 20, PRESENCE_MIN_ROWS_PER_WEEK - 1)
    expect(detectPresencePeriods(rows, null)).toHaveLength(0)
  })

  it(`fewer than ${PRESENCE_MIN_WEEKS} active weeks is not a period`, () => {
    const rows = weeksOf('IT', 0, PRESENCE_MIN_WEEKS - 2)
    expect(detectPresencePeriods(rows, null)).toHaveLength(0)
  })

  it('an empty / all-online (no-location) workspace yields no periods', () => {
    expect(detectPresencePeriods([], null)).toHaveLength(0)
    const online = weeksOf('IT', 0, 9).map(r => ({ ...r, loc_code: null }))
    expect(detectPresencePeriods(online, null)).toHaveLength(0)
  })
})

describe('detectPresencePeriods — gaps and the year boundary', () => {
  it('a short gap (≤2 inactive weeks) merges into one period', () => {
    const rows = [...weeksOf('IT', 0, 2), ...weeksOf('IT', 5, 7)]
    const p = detectPresencePeriods(rows, null)
    expect(p).toHaveLength(1)
    expect(p[0].end).toBe(dateOf(7, 1)) // last generated row: week 7, 2nd day
  })

  it('a long gap splits into two periods', () => {
    const rows = [...weeksOf('IT', 0, 3), ...weeksOf('IT', 8, 11)]
    const p = detectPresencePeriods(rows, null)
    expect(p).toHaveLength(2)
  })

  it('the ISO-year boundary never splits a continuous stay (weeks keyed by real Monday dates)', () => {
    // 2025-12-22, 2025-12-29, 2026-01-05, 2026-01-12 are consecutive Mondays.
    const w0 = Math.round((Date.UTC(2025, 11, 22) - MONDAY0) / (7 * 86400000))
    const rows = weeksOf('IT', w0, w0 + 3)
    const p = detectPresencePeriods(rows, null)
    expect(p).toHaveLength(1)
    expect(p[0].start).toBe('2025-12-22')
  })
})

describe('detectPresencePeriods — overlapping locations (two members, two countries)', () => {
  it('simultaneous stays in two countries yield two overlapping periods — no majority vote', () => {
    const rows = [...weeksOf('IT', 0, 9), ...weeksOf('AE', 0, 9)]
    const p = detectPresencePeriods(rows, null)
    expect(p).toHaveLength(2)
    expect(p.map(x => x.primary).sort()).toEqual(['AE', 'IT'])
  })
})

describe('detectPresencePeriods — EU/country containment merge (one stay, two code granularities)', () => {
  it('a country period overlapping an EU period ≥50% merges into ONE card sweeping both codes', () => {
    const rows = [
      ...weeksOf('PT', 0, 7, 2, { description: 'Farmacia Exposul Lisboa Card 5790' }),
      ...weeksOf('EU', 0, 7, 4, { description: 'Glovo 24MAR' }),
    ]
    const p = detectPresencePeriods(rows, null)
    expect(p).toHaveLength(1)
    expect(p[0].primary).toBe('PT')
    expect(p[0].loc_codes.sort()).toEqual(['EU', 'PT'])
    expect(p[0].row_count).toBe(16 + 32)
    // Card honesty: merchants from BOTH code sets are visible on the one card.
    expect(p[0].top_merchants.join(' ').toLowerCase()).toContain('glovo')
  })

  it('non-overlapping country and EU periods stay separate (disjoint sweeps)', () => {
    const rows = [...weeksOf('PT', 0, 3), ...weeksOf('EU', 10, 20)]
    const p = detectPresencePeriods(rows, null)
    expect(p).toHaveLength(2)
    const pt = p.find(x => x.primary === 'PT')!
    const eu = p.find(x => x.primary === 'EU')!
    expect(pt.loc_codes).toEqual(['PT'])
    expect(eu.loc_codes).toEqual(['EU'])
  })

  it('an EU period with no overlapping country period renders standalone', () => {
    const p = detectPresencePeriods(weeksOf('EU', 0, 9), null)
    expect(p).toHaveLength(1)
    expect(p[0].loc_codes).toEqual(['EU'])
    expect(p[0].primary).toBe('EU')
  })
})

describe('detectPresencePeriods — the fiscal-residence anchor', () => {
  it("the residence country's periods are suppressed (home life is the normal review)", () => {
    const rows = [...weeksOf('AE', 0, 20), ...weeksOf('IT', 4, 12)]
    const p = detectPresencePeriods(rows, 'AE')
    expect(p).toHaveLength(1)
    expect(p[0].primary).toBe('IT')
  })

  it("an EU-resident client's 'EU' region periods are suppressed too (indistinguishable from home)", () => {
    const rows = [...weeksOf('EU', 0, 20), ...weeksOf('AE', 4, 12)]
    const p = detectPresencePeriods(rows, 'IT')
    expect(p).toHaveLength(1)
    expect(p[0].primary).toBe('AE')
  })

  it('no residence on file → nothing suppressed', () => {
    const rows = [...weeksOf('AE', 0, 8), ...weeksOf('IT', 10, 18)]
    expect(detectPresencePeriods(rows, null)).toHaveLength(2)
  })
})

describe('detectPresencePeriods — sweep scoping', () => {
  it('an all-manual period is still detected but has zero sweepable rows (no card renders)', () => {
    const rows = weeksOf('IT', 0, 7, 3, { notes: 'manual: staff answer (business_expense)', category: 'expense' })
    const p = detectPresencePeriods(rows, null)
    expect(p).toHaveLength(1)
    expect(p[0].sweepable_count).toBe(0)
    expect(p[0].sweepable_total).toBe(0)
  })

  it('sweepable counts include ai:high-booked rows and exclude income/conversion', () => {
    const rows = [
      ...weeksOf('IT', 0, 7, 2, { category: 'expense', notes: 'ai:high@v2 — auto-booked' }),
      ...weeksOf('IT', 0, 7, 1, { category: 'income', amount: 500 } as Partial<LocatableRow>),
    ]
    const p = detectPresencePeriods(rows, null)
    expect(p).toHaveLength(1)
    expect(p[0].sweepable_count).toBe(16) // the ai:high expenses; income never
  })
})

describe('isSweepableRow — the endpoint predicate mirror', () => {
  const base: LocatableRow = { id: 'x', transaction_date: '2025-03-03', description: 'Glovo', counterparty: null, amount: -10, category: 'uncategorized', notes: null, loc_code: 'EU' }
  it('uncategorized with NULL notes IS sweepable (the NULL-notes trap test)', () => {
    expect(isSweepableRow(base)).toBe(true)
  })
  it('ai:high expense is sweepable; manual rows never; income/conversion/inflows never', () => {
    expect(isSweepableRow({ ...base, category: 'expense', notes: 'ai:high@v2' })).toBe(true)
    expect(isSweepableRow({ ...base, notes: 'manual: staff answer (x)' })).toBe(false)
    expect(isSweepableRow({ ...base, category: 'income', amount: 100 })).toBe(false)
    expect(isSweepableRow({ ...base, category: 'conversion' })).toBe(false)
    expect(isSweepableRow({ ...base, amount: 10 })).toBe(false)
  })
})

describe('detectPresencePeriods — flat-window recount (display ≡ sweep, prod 2026-07-04)', () => {
  it('rows in below-floor weeks INSIDE the window are counted (the endless-409 fix)', () => {
    // 8 active weeks at floor + ONE straggler row in a quiet week inside the
    // window: run-based counting excluded it; the sweep window includes it.
    const rows = [...weeksOf('IT', 0, 3), ...weeksOf('IT', 6, 9), row(5, 'IT')]
    const p = detectPresencePeriods(rows, null)
    expect(p).toHaveLength(1)
    expect(p[0].row_count).toBe(2 * 8 + 1)
    expect(p[0].sweepable_count).toBe(2 * 8 + 1)
  })

  it('merged EU+country period counts EVERY located row of both codes in the union window', () => {
    const rows = [
      ...weeksOf('PT', 0, 7, 2),
      ...weeksOf('EU', 0, 7, 4),
      row(3, 'EU'), // below-floor-irrelevant: extra EU row mid-window
    ]
    const p = detectPresencePeriods(rows, null)
    expect(p).toHaveLength(1)
    expect(p[0].row_count).toBe(16 + 32 + 1)
  })
})
