import { describe, it, expect } from 'vitest'
import {
  OFFICE_CLOSURES,
  activeClosureOn,
  closureCopy,
  closurePhaseOn,
  type OfficeClosure,
} from '@/lib/portal/office-closures'
import { getActiveClosure, getOfficeStatus } from '@/lib/portal/office-hours'

// The list itself is data a person edits by hand a few times a year, so these tests guard its SHAPE: a typo in a date must fail here,
// not silently close (or fail to close) the office for real clients.

const DATE = /^\d{4}-\d{2}-\d{2}$/

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000)
}

/** 10:00 AM New York on a given day (all the closure days are outside daylight saving, so 15:00Z; EDT days would be 14:00Z — 10 AM EST is inside both hours). */
function tenAmEt(day: string): Date {
  return new Date(`${day}T15:00:00Z`)
}

describe('OFFICE_CLOSURES — the list is well formed', () => {
  it('has unique ids', () => {
    const ids = OFFICE_CLOSURES.map(c => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  for (const c of OFFICE_CLOSURES) {
    describe(c.id, () => {
      it('uses plain YYYY-MM-DD days that really exist', () => {
        for (const d of [c.noticeFrom, c.closedFrom, c.closedUntil, c.reopens]) {
          expect(d).toMatch(DATE)
          expect(new Date(`${d}T12:00:00Z`).toISOString().slice(0, 10)).toBe(d)
        }
      })

      it('runs in order: notice, closed, reopen', () => {
        expect(c.noticeFrom <= c.closedFrom).toBe(true)
        expect(c.closedFrom <= c.closedUntil).toBe(true)
        expect(c.closedUntil < c.reopens).toBe(true)
      })

      it('is a short closure (a typo like 2062 must not close the office for years)', () => {
        expect(daysBetween(c.closedFrom, c.closedUntil)).toBeLessThanOrEqual(21)
        expect(daysBetween(c.noticeFrom, c.closedFrom)).toBeLessThanOrEqual(14)
        expect(daysBetween(c.closedUntil, c.reopens)).toBeLessThanOrEqual(4)
      })

      it('reopens on a day the normal rule has the office open', () => {
        // closures [] = the normal Mon–Fri 9–3 rule plus federal holidays only
        expect(getOfficeStatus(tenAmEt(c.reopens), []).open).toBe(true)
      })

      it('leaves no working day between the last closed day and the reopen day', () => {
        // otherwise the clock would say "open" on a day the notice says we are still away
        for (let d = c.closedUntil; ; ) {
          const next = new Date(Date.parse(`${d}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
          if (next >= c.reopens) break
          expect(getOfficeStatus(tenAmEt(next), []).open).toBe(false)
          d = next
        }
      })

      it('has both languages, every sentence filled in', () => {
        for (const locale of ['en', 'it'] as const) {
          for (const [key, value] of Object.entries(c.copy[locale])) {
            expect(typeof value, `${locale}.${key}`).toBe('string')
            expect((value as string).trim().length, `${locale}.${key}`).toBeGreaterThan(10)
          }
        }
      })

      it('names the reopen day in the clock line and the chat reply, in both languages', () => {
        // the reopen day is written as words ("Monday, November 30" / "lunedì 30 novembre"): look for the day number
        const day = String(Number(c.reopens.slice(8, 10)))
        for (const locale of ['en', 'it'] as const) {
          expect(c.copy[locale].clockSub).toContain(day)
          expect(c.copy[locale].autoReply).toContain(day)
          expect(c.copy[locale].closedMessage).toContain(day)
          expect(c.copy[locale].noticeMessage).toContain(day)
        }
      })
    })
  }
})

describe('Thanksgiving 2026 — day by day', () => {
  const phase = (d: string) => activeClosureOn(d)?.phase ?? null

  it('is quiet before the heads-up', () => {
    expect(phase('2026-11-22')).toBeNull()
  })
  it('shows the heads-up on Mon 23 and Tue 24', () => {
    expect(phase('2026-11-23')).toBe('notice')
    expect(phase('2026-11-24')).toBe('notice')
  })
  it('is closed Wed 25 through Sun 29 (end day included)', () => {
    for (const d of ['2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29']) expect(phase(d)).toBe('closed')
  })
  it('is back to normal on Mon 30', () => {
    expect(phase('2026-11-30')).toBeNull()
  })
})

describe('closurePhaseOn / activeClosureOn', () => {
  const mk = (id: string, noticeFrom: string, closedFrom: string, closedUntil: string): OfficeClosure => ({
    id, noticeFrom, closedFrom, closedUntil, reopens: '2099-01-01', copy: OFFICE_CLOSURES[0].copy,
  })

  it('a closed closure wins over another closure\'s heads-up on the same day', () => {
    const a = mk('a', '2030-03-01', '2030-03-05', '2030-03-07')
    const b = mk('b', '2030-03-04', '2030-03-10', '2030-03-12')
    const active = activeClosureOn('2030-03-06', [b, a])
    expect(active?.closure.id).toBe('a')
    expect(active?.phase).toBe('closed')
    expect(activeClosureOn('2030-03-04', [a, b])?.phase).toBe('notice')
  })

  it('compares the day as text, edges included', () => {
    const c = mk('c', '2030-03-01', '2030-03-05', '2030-03-07')
    expect(closurePhaseOn('2030-02-28', c)).toBeNull()
    expect(closurePhaseOn('2030-03-01', c)).toBe('notice')
    expect(closurePhaseOn('2030-03-04', c)).toBe('notice')
    expect(closurePhaseOn('2030-03-05', c)).toBe('closed')
    expect(closurePhaseOn('2030-03-07', c)).toBe('closed')
    expect(closurePhaseOn('2030-03-08', c)).toBeNull()
  })

  it('an empty list means no closure', () => {
    expect(activeClosureOn('2026-11-26', [])).toBeNull()
  })
})

describe('closureCopy', () => {
  const c = OFFICE_CLOSURES[0]
  it('Italian for it, English for en and for anything else', () => {
    expect(closureCopy(c, 'it')).toBe(c.copy.it)
    expect(closureCopy(c, 'en')).toBe(c.copy.en)
    expect(closureCopy(c, 'es')).toBe(c.copy.en)
    expect(closureCopy(c, null)).toBe(c.copy.en)
    expect(closureCopy(c, undefined)).toBe(c.copy.en)
  })
})

describe('getActiveClosure reads the New York day', () => {
  it('Tue 24 Nov 11:30 PM ET is still the heads-up; Wed 25 Nov 12:30 AM ET is closed', () => {
    // EST (UTC-5) from 1 Nov 2026
    expect(getActiveClosure(new Date('2026-11-25T04:30:00Z'))?.phase).toBe('notice') // Tue 11:30 PM ET
    expect(getActiveClosure(new Date('2026-11-25T05:30:00Z'))?.phase).toBe('closed') // Wed 12:30 AM ET
  })
  it('Sun 29 Nov 11:30 PM ET is closed; Mon 30 Nov 12:30 AM ET is not a closure any more', () => {
    expect(getActiveClosure(new Date('2026-11-30T04:30:00Z'))?.phase).toBe('closed')
    expect(getActiveClosure(new Date('2026-11-30T05:30:00Z'))).toBeNull()
  })
})
