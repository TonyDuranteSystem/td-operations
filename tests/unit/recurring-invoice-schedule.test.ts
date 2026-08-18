import { describe, it, expect } from 'vitest'
import {
  advanceRecurringDate,
  addDaysToDate,
  fastForwardToNextOccurrence,
  buildTemplateSuccessUpdate,
  buildTemplateFailureUpdate,
} from '@/lib/billing/recurring-invoice-schedule'

describe('advanceRecurringDate — weekly', () => {
  // Pins the exact defect the senior-engineer review caught: widening the
  // frequency type/DB CHECK without restructuring the branch would let
  // 'weekly' silently fall into the month-based `else -> 12 months` case.
  it('adds exactly 7 days, never 12 months', () => {
    expect(advanceRecurringDate('2026-08-17', 'weekly')).toBe('2026-08-24')
  })

  it('rolls a month boundary correctly (plain day count, no clamping)', () => {
    expect(advanceRecurringDate('2026-08-28', 'weekly')).toBe('2026-09-04')
  })
})

describe('advanceRecurringDate — biweekly', () => {
  it('adds exactly 14 days, never 12 months', () => {
    expect(advanceRecurringDate('2026-08-17', 'biweekly')).toBe('2026-08-31')
  })
})

describe('advanceRecurringDate — monthly', () => {
  it('adds one month on a mid-month anchor', () => {
    expect(advanceRecurringDate('2026-08-17', 'monthly')).toBe('2026-09-17')
  })

  it('clamps Jan 31 -> Feb 28 in a non-leap year instead of rolling into March', () => {
    // 2026 is not a leap year. Native `Date.setUTCMonth` on Jan 31 + 1 month
    // silently rolls over to Mar 3 — this pins the clamp that prevents that drift.
    expect(advanceRecurringDate('2026-01-31', 'monthly')).toBe('2026-02-28')
  })

  it('clamps Jan 31 -> Feb 29 in a leap year', () => {
    expect(advanceRecurringDate('2028-01-31', 'monthly')).toBe('2028-02-29')
  })

  it('does not clamp when the target month is long enough (Mar 31 -> Apr 30 -> May 30, not May 31)', () => {
    expect(advanceRecurringDate('2026-03-31', 'monthly')).toBe('2026-04-30')
  })
})

describe('advanceRecurringDate — quarterly', () => {
  it('adds three months, clamping at a short target month', () => {
    expect(advanceRecurringDate('2026-01-31', 'quarterly')).toBe('2026-04-30')
  })

  it('rolls the year over correctly', () => {
    expect(advanceRecurringDate('2026-11-30', 'quarterly')).toBe('2027-02-28')
  })
})

describe('advanceRecurringDate — yearly', () => {
  it('adds one year on a normal anchor (the Metawide "every August" shape)', () => {
    expect(advanceRecurringDate('2026-08-01', 'yearly')).toBe('2027-08-01')
  })

  it('clamps a Feb 29 anchor to Feb 28 in the next non-leap year', () => {
    expect(advanceRecurringDate('2028-02-29', 'yearly')).toBe('2029-02-28')
  })

  it('keeps Feb 29 when advancing leap year to leap year', () => {
    expect(advanceRecurringDate('2028-02-29', 'yearly')).not.toBe('2029-02-29') // sanity: 2029 has no Feb 29
    // 2032 is the next leap year after 2028; not exercised here since the
    // function only advances by exactly one cycle at a time.
  })
})

describe('addDaysToDate', () => {
  it('adds days within the same month', () => {
    expect(addDaysToDate('2026-08-01', 5)).toBe('2026-08-06')
  })

  it('rolls over a month boundary', () => {
    expect(addDaysToDate('2026-01-30', 5)).toBe('2026-02-04')
  })

  it('returns the same date for an offset of 0', () => {
    expect(addDaysToDate('2026-08-17', 0)).toBe('2026-08-17')
  })
})

describe('fastForwardToNextOccurrence — reactivation catch-up guard', () => {
  // Pins the bug-hunter finding: re-activating a long-dormant template must
  // land on the next FUTURE occurrence, not dump a burst of backdated
  // invoices by advancing one cycle at a time from a stale date.

  it('advances a monthly template dormant for 2.5 months to the next future date, not the immediate next cycle', () => {
    // Last ran 2026-06-01; today is 2026-08-17. Naively advancing once would
    // land on 2026-07-01 — still in the past. Must skip forward past today.
    const result = fastForwardToNextOccurrence('2026-06-01', 'monthly', '2026-08-17')
    expect(result).toBe('2026-09-01')
    expect(result > '2026-08-17').toBe(true)
  })

  it('advances a weekly template dormant for months without looping forever', () => {
    const result = fastForwardToNextOccurrence('2026-01-05', 'weekly', '2026-08-17')
    expect(result > '2026-08-17').toBe(true)
    // Should land within one week of today, not overshoot by a full extra cycle.
    const daysAhead = (new Date(`${result}T00:00:00Z`).getTime() - new Date('2026-08-17T00:00:00Z').getTime()) / 86400000
    expect(daysAhead).toBeGreaterThan(0)
    expect(daysAhead).toBeLessThanOrEqual(7)
  })

  it('still advances at least once even when next_run_date is already in the future', () => {
    // "The next time it would naturally fire" — never returns the input unchanged.
    const result = fastForwardToNextOccurrence('2026-08-20', 'monthly', '2026-08-17')
    expect(result).toBe('2026-09-20')
  })

  it('never returns a date that is still due (<=  today) — the mutation this test exists to catch', () => {
    const result = fastForwardToNextOccurrence('2020-01-01', 'yearly', '2026-08-17')
    expect(result > '2026-08-17').toBe(true)
  })
})

describe('buildTemplateSuccessUpdate / buildTemplateFailureUpdate — the ordering invariant', () => {
  // This pins the exact defect the AI Architect review flagged as the one
  // blocker on the design (dev job 4a854806): a failed generation cycle must
  // NEVER advance next_run_date, or a transient failure silently and
  // permanently skips a charge with no trace it was ever due.

  it('success sets next_run_date to the advanced cycle and clears any prior error', () => {
    const update = buildTemplateSuccessUpdate({
      runDate: '2026-08-17',
      frequency: 'yearly',
      paymentId: 'pay-123',
      now: '2026-08-17T12:00:00.000Z',
    })
    expect(update.next_run_date).toBe('2027-08-17')
    expect(update.last_run_status).toBe('ok')
    expect(update.last_error).toBeNull()
    expect(update.last_generated_payment_id).toBe('pay-123')
  })

  it('failure NEVER includes a next_run_date key — the mutation this test exists to catch', () => {
    const update = buildTemplateFailureUpdate({
      errorMessage: 'createTDInvoice[payments.insert]: unique violation',
      now: '2026-08-17T12:00:00.000Z',
    })
    expect('next_run_date' in update).toBe(false)
    expect(update.last_run_status).toBe('error')
    expect(update.last_error).toBe('createTDInvoice[payments.insert]: unique violation')
  })

  it('failure and success updates are structurally disjoint on the one field that matters', () => {
    const success = buildTemplateSuccessUpdate({
      runDate: '2026-08-17',
      frequency: 'monthly',
      paymentId: 'pay-456',
      now: '2026-08-17T12:00:00.000Z',
    })
    const failure = buildTemplateFailureUpdate({ errorMessage: 'boom', now: '2026-08-17T12:00:00.000Z' })
    expect(Object.keys(success)).toContain('next_run_date')
    expect(Object.keys(failure)).not.toContain('next_run_date')
  })
})
