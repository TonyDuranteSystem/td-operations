import { describe, it, expect } from 'vitest'
import { isFormationDoneForAccounts, shouldSuppressReminder } from '@/lib/portal/wizard-reminder-rules'

const DAY = 24 * 60 * 60 * 1000

describe('isFormationDoneForAccounts', () => {
  it('is done when the only company is formed', () => {
    expect(isFormationDoneForAccounts([{ formation_date: '2026-04-20' }])).toBe(true)
  })

  it('is done when ALL companies are formed', () => {
    expect(isFormationDoneForAccounts([
      { formation_date: '2026-04-20' },
      { formation_date: '2026-06-01' },
    ])).toBe(true)
  })

  it('is NOT done while a second company is still forming', () => {
    // The case "any" would have broken: a client who formed one company and is
    // now forming another still needs to complete the new form. Real — one
    // production client has two submitted formation wizards.
    expect(isFormationDoneForAccounts([
      { formation_date: '2026-04-20' },
      { formation_date: null },
    ])).toBe(false)
  })

  it('is NOT done when nothing is formed yet', () => {
    expect(isFormationDoneForAccounts([{ formation_date: null }])).toBe(false)
  })

  it('is NOT done when we cannot see any company', () => {
    // Fail toward reminding. Silence here would mean a real client is never
    // chased at all, which is worse than one reminder too many.
    expect(isFormationDoneForAccounts([])).toBe(false)
  })

  it('treats an empty-string date as not formed', () => {
    expect(isFormationDoneForAccounts([{ formation_date: '' }])).toBe(false)
  })

  it('treats a missing key as not formed', () => {
    expect(isFormationDoneForAccounts([{}])).toBe(false)
  })
})

describe('shouldSuppressReminder', () => {
  const base = { repeatAfterMs: 7 * DAY, maxRepeats: 4 }

  it('sends the first reminder', () => {
    expect(shouldSuppressReminder({ ...base, msSinceLastSameReminder: null, timesAlreadySent: 0 })).toBe(false)
  })

  it('suppresses a repeat inside the window', () => {
    // The actual bug: a 2-day window on a reminder called "7-day", so it re-fired
    // every 2-3 days for months.
    expect(shouldSuppressReminder({ ...base, msSinceLastSameReminder: 2 * DAY, timesAlreadySent: 1 })).toBe(true)
    expect(shouldSuppressReminder({ ...base, msSinceLastSameReminder: 6.9 * DAY, timesAlreadySent: 1 })).toBe(true)
  })

  it('allows the repeat once a full week has passed', () => {
    expect(shouldSuppressReminder({ ...base, msSinceLastSameReminder: 7 * DAY, timesAlreadySent: 1 })).toBe(false)
  })

  it('STOPS at the cap, however long ago the last one was', () => {
    // Filippo Bernardini received 22 of the same reminder because nothing ever
    // stopped it. The 7-day branch opens a staff task, so a human still follows up.
    expect(shouldSuppressReminder({ ...base, msSinceLastSameReminder: 365 * DAY, timesAlreadySent: 4 })).toBe(true)
    expect(shouldSuppressReminder({ ...base, msSinceLastSameReminder: 365 * DAY, timesAlreadySent: 22 })).toBe(true)
  })

  it('sends right up to the cap but not past it', () => {
    expect(shouldSuppressReminder({ ...base, msSinceLastSameReminder: 8 * DAY, timesAlreadySent: 3 })).toBe(false)
    expect(shouldSuppressReminder({ ...base, msSinceLastSameReminder: 8 * DAY, timesAlreadySent: 4 })).toBe(true)
  })
})
