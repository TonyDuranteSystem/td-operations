import { describe, it, expect } from 'vitest'
import { isValidTimeZone, shouldRefreshLastSeen } from '@/lib/portal/last-seen-location'

describe('isValidTimeZone', () => {
  it('accepts real IANA timezones', () => {
    expect(isValidTimeZone('Asia/Jakarta')).toBe(true)
    expect(isValidTimeZone('Europe/Malta')).toBe(true)
    expect(isValidTimeZone('America/New_York')).toBe(true)
  })

  it('rejects null, undefined, empty, and garbage values', () => {
    expect(isValidTimeZone(null)).toBe(false)
    expect(isValidTimeZone(undefined)).toBe(false)
    expect(isValidTimeZone('')).toBe(false)
    expect(isValidTimeZone('not-a-timezone')).toBe(false)
    expect(isValidTimeZone('Jakarta')).toBe(false)
    expect(isValidTimeZone('<script>alert(1)</script>')).toBe(false)
  })
})

describe('shouldRefreshLastSeen', () => {
  const now = new Date('2026-08-27T18:00:00Z')

  it('is due when there is no prior timestamp', () => {
    expect(shouldRefreshLastSeen(null, now)).toBe(true)
    expect(shouldRefreshLastSeen(undefined, now)).toBe(true)
  })

  it('is due when the prior timestamp is unparseable', () => {
    expect(shouldRefreshLastSeen('not-a-date', now)).toBe(true)
  })

  it('is NOT due within the refresh window', () => {
    const thirtyMinAgo = new Date('2026-08-27T17:30:00Z').toISOString()
    expect(shouldRefreshLastSeen(thirtyMinAgo, now)).toBe(false)
  })

  it('is due once the refresh window has passed', () => {
    const twoHoursAgo = new Date('2026-08-27T16:00:00Z').toISOString()
    expect(shouldRefreshLastSeen(twoHoursAgo, now)).toBe(true)
  })

  it('is due exactly at the boundary', () => {
    const exactlyOneHourAgo = new Date('2026-08-27T17:00:00Z').toISOString()
    expect(shouldRefreshLastSeen(exactlyOneHourAgo, now)).toBe(true)
  })
})
