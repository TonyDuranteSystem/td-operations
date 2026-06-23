import { describe, it, expect } from 'vitest'
import { isOfficeOpen, isOfficeHoliday, getOfficeStatus, usFederalHolidays } from '@/lib/portal/office-hours'

/**
 * All test dates are chosen to have unambiguous ET offsets:
 *   - May 2026 = EDT (UTC-4)
 *   - January 2026 = EST (UTC-5)
 *
 * UTC times are derived as: ET_time + offset → UTC
 * e.g. Monday 10:00 AM EDT = Monday 14:00 UTC
 */

describe('isOfficeOpen', () => {
  // --- Open cases ---

  it('Mon 9:00 AM EDT → open (lower boundary)', () => {
    // 2026-05-18 Mon 09:00 EDT = 13:00 UTC
    expect(isOfficeOpen(new Date('2026-05-18T13:00:00Z'))).toBe(true)
  })

  it('Mon 10:00 AM EDT → open', () => {
    expect(isOfficeOpen(new Date('2026-05-18T14:00:00Z'))).toBe(true)
  })

  it('Wed 1:00 PM EDT → open (midweek, midday)', () => {
    // 2026-05-20 Wed 13:00 EDT = 17:00 UTC
    expect(isOfficeOpen(new Date('2026-05-20T17:00:00Z'))).toBe(true)
  })

  it('Fri 2:59 PM EDT → open (1 minute before close)', () => {
    // 2026-05-22 Fri 14:59 EDT = 18:59 UTC
    expect(isOfficeOpen(new Date('2026-05-22T18:59:00Z'))).toBe(true)
  })

  // EST (winter — UTC-5)
  it('Tue 11:00 AM EST → open (winter offset)', () => {
    // 2026-01-06 Tue 11:00 EST = 16:00 UTC
    expect(isOfficeOpen(new Date('2026-01-06T16:00:00Z'))).toBe(true)
  })

  // --- Closed cases ---

  it('Mon 8:59 AM EDT → closed (before open)', () => {
    // 2026-05-18 Mon 08:59 EDT = 12:59 UTC
    expect(isOfficeOpen(new Date('2026-05-18T12:59:00Z'))).toBe(false)
  })

  it('Fri 3:00 PM EDT → closed (at closing time, exclusive)', () => {
    // 2026-05-22 Fri 15:00 EDT = 19:00 UTC
    expect(isOfficeOpen(new Date('2026-05-22T19:00:00Z'))).toBe(false)
  })

  it('Fri 6:00 PM EDT → closed (evening)', () => {
    expect(isOfficeOpen(new Date('2026-05-22T22:00:00Z'))).toBe(false)
  })

  it('Mon midnight EDT → closed', () => {
    // 2026-05-18 00:00 EDT = 04:00 UTC
    expect(isOfficeOpen(new Date('2026-05-18T04:00:00Z'))).toBe(false)
  })

  it('Saturday 10:00 AM EDT → closed (weekend)', () => {
    // 2026-05-23 Sat 10:00 EDT = 14:00 UTC
    expect(isOfficeOpen(new Date('2026-05-23T14:00:00Z'))).toBe(false)
  })

  it('Sunday 10:00 AM EDT → closed (weekend)', () => {
    // 2026-05-24 Sun 10:00 EDT = 14:00 UTC
    expect(isOfficeOpen(new Date('2026-05-24T14:00:00Z'))).toBe(false)
  })

  // --- Holidays (closed even on a weekday during 9–3) ---

  it("New Year's Day (Thu Jan 1 2026) 12:00 EST → closed (holiday)", () => {
    // 2026-01-01 12:00 EST = 17:00 UTC. A Thursday — only the holiday makes it closed.
    expect(isOfficeOpen(new Date('2026-01-01T17:00:00Z'))).toBe(false)
  })

  it('Thanksgiving (Thu Nov 26 2026) 12:00 EST → closed (holiday)', () => {
    expect(isOfficeOpen(new Date('2026-11-26T17:00:00Z'))).toBe(false)
  })

  it('Independence Day observed (Fri Jul 3 2026) 12:00 EDT → closed (Jul 4 is a Saturday)', () => {
    // 2026-07-03 12:00 EDT = 16:00 UTC
    expect(isOfficeOpen(new Date('2026-07-03T16:00:00Z'))).toBe(false)
  })
})

describe('getOfficeStatus — reason', () => {
  it('Wed 1:00 PM EDT → open', () => {
    expect(getOfficeStatus(new Date('2026-05-20T17:00:00Z'))).toEqual({ open: true, reason: 'open' })
  })
  it('Mon 8:00 AM EDT → before_hours', () => {
    // 2026-05-18 08:00 EDT = 12:00 UTC
    expect(getOfficeStatus(new Date('2026-05-18T12:00:00Z'))).toEqual({ open: false, reason: 'before_hours' })
  })
  it('Mon 4:00 PM EDT → after_hours', () => {
    // 2026-05-18 16:00 EDT = 20:00 UTC
    expect(getOfficeStatus(new Date('2026-05-18T20:00:00Z'))).toEqual({ open: false, reason: 'after_hours' })
  })
  it('Sat noon EDT → weekend', () => {
    expect(getOfficeStatus(new Date('2026-05-23T16:00:00Z'))).toEqual({ open: false, reason: 'weekend' })
  })
  it('New Year noon → holiday (takes precedence over hours)', () => {
    expect(getOfficeStatus(new Date('2026-01-01T17:00:00Z'))).toEqual({ open: false, reason: 'holiday' })
  })
})

describe('usFederalHolidays', () => {
  it('computes the 11 observed federal holidays for 2026', () => {
    const h = usFederalHolidays(2026)
    expect(h.has('2026-01-01')).toBe(true) // New Year's
    expect(h.has('2026-01-19')).toBe(true) // MLK — 3rd Mon Jan
    expect(h.has('2026-02-16')).toBe(true) // Presidents — 3rd Mon Feb
    expect(h.has('2026-05-25')).toBe(true) // Memorial — last Mon May
    expect(h.has('2026-06-19')).toBe(true) // Juneteenth
    expect(h.has('2026-07-03')).toBe(true) // Independence (observed — Jul 4 is Sat)
    expect(h.has('2026-09-07')).toBe(true) // Labor — 1st Mon Sep
    expect(h.has('2026-10-12')).toBe(true) // Columbus — 2nd Mon Oct
    expect(h.has('2026-11-11')).toBe(true) // Veterans
    expect(h.has('2026-11-26')).toBe(true) // Thanksgiving — 4th Thu Nov
    expect(h.has('2026-12-25')).toBe(true) // Christmas
  })

  it('isOfficeHoliday matches a known holiday and rejects a normal day', () => {
    expect(isOfficeHoliday(new Date('2026-12-25T17:00:00Z'))).toBe(true)
    expect(isOfficeHoliday(new Date('2026-05-20T17:00:00Z'))).toBe(false)
  })
})
