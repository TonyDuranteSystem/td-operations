import { describe, it, expect } from 'vitest'
import { isOfficeOpen } from '@/lib/portal/office-hours'

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
})
