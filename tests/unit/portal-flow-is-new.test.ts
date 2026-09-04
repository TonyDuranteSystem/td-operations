/**
 * Unit test for isWithinNewBadgeWindow (lib/portal/queries.ts) — the "NEW"
 * tag shown on a service-flow card for the first NEW_FLOW_BADGE_DAYS after
 * creation. Off-by-one found in council review (2026-09-04): the previous
 * `<=` kept the tag visible for a full 8th day; fixed to strictly-less-than.
 * R086: every new function in lib/ gets a unit test.
 */

import { describe, it, expect } from 'vitest'
import { isWithinNewBadgeWindow } from '@/lib/portal/queries'

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 3600000).toISOString()
}

describe('isWithinNewBadgeWindow', () => {
  it('is true for a flow created moments ago', () => {
    expect(isWithinNewBadgeWindow(hoursAgo(0))).toBe(true)
  })

  it('is true just under the 7-day window (6 days 23 hours)', () => {
    expect(isWithinNewBadgeWindow(hoursAgo(6 * 24 + 23))).toBe(true)
  })

  it('is false at exactly 7 full days — the window is 7 days, not 8', () => {
    expect(isWithinNewBadgeWindow(hoursAgo(7 * 24))).toBe(false)
  })

  it('is false well past the window (30 days)', () => {
    expect(isWithinNewBadgeWindow(hoursAgo(30 * 24))).toBe(false)
  })
})
