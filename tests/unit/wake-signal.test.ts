import { describe, it, expect } from 'vitest'
import { shouldWake, WAKE_DEFAULTS } from '@/lib/hooks/use-wake-signal'

/**
 * The DOM wiring is verified in a real browser (this repo's vitest is node-only,
 * no testing-library). These pin the DECISION, which is where the bugs were.
 */
describe('shouldWake', () => {
  const now = 1_000_000_000

  it('does NOT wake when we never saw the user leave', () => {
    // The bug this prevents: using 0 as "no record" makes `now - 0` enormous, so
    // the away-gate passes on every desktop alt-tab and the app re-renders the
    // world all day. "Never left" must mean "never away", not "away since 1970".
    expect(shouldWake({ leftAt: null, now })).toBe(false)
  })

  it('does NOT wake for a glance away', () => {
    expect(shouldWake({ leftAt: now - 1_000, now })).toBe(false)
    expect(shouldWake({ leftAt: now - (WAKE_DEFAULTS.awayMs - 1), now })).toBe(false)
  })

  it('wakes exactly at the threshold', () => {
    expect(shouldWake({ leftAt: now - WAKE_DEFAULTS.awayMs, now })).toBe(true)
  })

  it('wakes after a real absence — minutes, hours, days', () => {
    expect(shouldWake({ leftAt: now - 60_000, now })).toBe(true)
    expect(shouldWake({ leftAt: now - 3_600_000, now })).toBe(true)
    // The case the whole feature exists for: a phone PWA backgrounded for days.
    expect(shouldWake({ leftAt: now - 14 * 24 * 3_600_000, now })).toBe(true)
  })

  it('honours a custom away window', () => {
    expect(shouldWake({ leftAt: now - 30_000, now, awayMs: 60_000 })).toBe(false)
    expect(shouldWake({ leftAt: now - 90_000, now, awayMs: 60_000 })).toBe(true)
  })

  it('defaults are the reviewed values (20s away, 5s throttle)', () => {
    // Changing these changes cost-per-user-per-day. The portal wake re-renders
    // the whole route server-side (~15 queries in the layout alone), so the gate
    // is a cost control, not a nicety.
    expect(WAKE_DEFAULTS.awayMs).toBe(20_000)
    expect(WAKE_DEFAULTS.throttleMs).toBe(5_000)
  })
})
