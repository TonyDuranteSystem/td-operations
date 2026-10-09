import { describe, it, expect } from 'vitest'
import { nextRecurringDate, daysBetween, addDaysYmd } from '@/lib/portal/recurring-date'

describe('nextRecurringDate', () => {
  it('moves one month, one quarter, one year', () => {
    expect(nextRecurringDate('2026-10-09', 'monthly')).toBe('2026-11-09')
    expect(nextRecurringDate('2026-10-09', 'quarterly')).toBe('2027-01-09')
    expect(nextRecurringDate('2026-10-09', 'yearly')).toBe('2027-10-09')
  })
  it('clamps to the end of a short month instead of overflowing (Jan 31 used to become Mar 3)', () => {
    expect(nextRecurringDate('2026-01-31', 'monthly')).toBe('2026-02-28')
    expect(nextRecurringDate('2028-01-31', 'monthly')).toBe('2028-02-29') // leap year
    expect(nextRecurringDate('2026-08-31', 'monthly')).toBe('2026-09-30')
    expect(nextRecurringDate('2028-02-29', 'yearly')).toBe('2029-02-28')
  })
  it('does not drift: the anchor day brings a 31st schedule back to the 31st', () => {
    const feb = nextRecurringDate('2026-01-31', 'monthly', 31)!
    expect(feb).toBe('2026-02-28')
    expect(nextRecurringDate(feb, 'monthly', 31)).toBe('2026-03-31')
    expect(nextRecurringDate('2026-03-31', 'monthly', 31)).toBe('2026-04-30')
  })
  it('rolls the year over in December', () => {
    expect(nextRecurringDate('2026-12-15', 'monthly')).toBe('2027-01-15')
    expect(nextRecurringDate('2026-11-30', 'quarterly')).toBe('2027-02-28')
  })
  it('returns null for something that is not a date (the caller must treat it as an error)', () => {
    expect(nextRecurringDate('', 'monthly')).toBeNull()
    expect(nextRecurringDate('soon', 'monthly')).toBeNull()
    expect(nextRecurringDate('2026-13-01', 'monthly')).toBeNull()
  })
})

describe('daysBetween / addDaysYmd', () => {
  it('counts calendar days', () => {
    expect(daysBetween('2026-10-01', '2026-10-31')).toBe(30)
    expect(daysBetween('2026-10-31', '2026-10-01')).toBe(-30)
    expect(daysBetween('x', '2026-10-01')).toBeNull()
  })
  it('adds days across month ends', () => {
    expect(addDaysYmd('2026-10-25', 10)).toBe('2026-11-04')
    expect(addDaysYmd('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDaysYmd('bad', 1)).toBeNull()
  })
})
