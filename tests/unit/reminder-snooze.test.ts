import { describe, it, expect } from 'vitest'
import { isReminderPaused, isAccountReminderPaused } from '@/lib/billing/reminder-snooze'

// Explicit-`now` time-travel pattern (same as the dunning eligibility tests) —
// never mock the system clock.
const NOW = new Date('2026-07-03T12:00:00')

describe('isReminderPaused', () => {
  it('is false for null / undefined / empty', () => {
    expect(isReminderPaused(null, NOW)).toBe(false)
    expect(isReminderPaused(undefined, NOW)).toBe(false)
    expect(isReminderPaused('', NOW)).toBe(false)
  })

  it('is false for an invalid date string', () => {
    expect(isReminderPaused('not-a-date', NOW)).toBe(false)
    expect(isReminderPaused('2026-13-45', NOW)).toBe(false)
  })

  it('is true for a future date', () => {
    expect(isReminderPaused('2026-09-30', NOW)).toBe(true)
    expect(isReminderPaused('2027-01-01', NOW)).toBe(true)
  })

  it('is true for today — the promise covers the whole promised day', () => {
    expect(isReminderPaused('2026-07-03', NOW)).toBe(true)
    // even late in the day
    expect(isReminderPaused('2026-07-03', new Date('2026-07-03T23:30:00'))).toBe(true)
  })

  it('is false the day after — reminders resume automatically', () => {
    expect(isReminderPaused('2026-07-02', NOW)).toBe(false)
    expect(isReminderPaused('2026-07-03', new Date('2026-07-04T00:00:01'))).toBe(false)
  })

  it('tolerates a timestamp-formatted value (takes the date part)', () => {
    expect(isReminderPaused('2026-09-30T00:00:00.000Z', NOW)).toBe(true)
    expect(isReminderPaused('2026-07-01T00:00:00.000Z', NOW)).toBe(false)
  })
})

describe('isAccountReminderPaused', () => {
  it('is false for a missing account or no pause of either kind', () => {
    expect(isAccountReminderPaused(null, NOW)).toBe(false)
    expect(isAccountReminderPaused(undefined, NOW)).toBe(false)
    expect(isAccountReminderPaused({}, NOW)).toBe(false)
    expect(isAccountReminderPaused({ dunning_pause: false, dunning_pause_until: null }, NOW)).toBe(false)
  })

  it('is true when the legacy boolean pause is on', () => {
    expect(isAccountReminderPaused({ dunning_pause: true }, NOW)).toBe(true)
  })

  it('is true while a dated pause is active, false after it expires', () => {
    expect(isAccountReminderPaused({ dunning_pause: false, dunning_pause_until: '2026-09-30' }, NOW)).toBe(true)
    expect(isAccountReminderPaused({ dunning_pause: false, dunning_pause_until: '2026-06-30' }, NOW)).toBe(false)
  })
})
