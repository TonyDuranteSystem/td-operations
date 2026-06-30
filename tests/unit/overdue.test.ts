import { describe, it, expect } from 'vitest'
import {
  daysPastDue,
  isOverduePayment,
  summarizeOverdue,
  type OverduePaymentRow,
} from '@/lib/billing/overdue'

const NOW = new Date('2026-06-30T12:00:00Z')

describe('daysPastDue', () => {
  it('counts whole days past the due date (UTC midnight)', () => {
    expect(daysPastDue('2026-06-15', NOW)).toBe(15)
    expect(daysPastDue('2026-06-29', NOW)).toBe(1)
  })
  it('returns 0 for a due date today or in the future', () => {
    expect(daysPastDue('2026-06-30', NOW)).toBe(0)
    expect(daysPastDue('2026-07-10', NOW)).toBe(0)
  })
  it('returns 0 for missing or invalid due dates', () => {
    expect(daysPastDue(null, NOW)).toBe(0)
    expect(daysPastDue(undefined, NOW)).toBe(0)
    expect(daysPastDue('not-a-date', NOW)).toBe(0)
  })
})

describe('isOverduePayment', () => {
  it('treats Overdue and Delinquent statuses as overdue regardless of due date', () => {
    expect(isOverduePayment({ status: 'Overdue', due_date: null }, NOW)).toBe(true)
    expect(isOverduePayment({ status: 'Delinquent', due_date: '2026-12-01' }, NOW)).toBe(true)
  })
  it('treats Pending past the due date as overdue', () => {
    expect(isOverduePayment({ status: 'Pending', due_date: '2026-06-01' }, NOW)).toBe(true)
  })
  it('does NOT treat Pending due today or in the future as overdue', () => {
    expect(isOverduePayment({ status: 'Pending', due_date: '2026-06-30' }, NOW)).toBe(false)
    expect(isOverduePayment({ status: 'Pending', due_date: '2026-07-15' }, NOW)).toBe(false)
    expect(isOverduePayment({ status: 'Pending', due_date: null }, NOW)).toBe(false)
  })
  it('never treats settled / non-billable statuses as overdue', () => {
    for (const status of ['Paid', 'Waived', 'Cancelled', 'Refunded', 'Not Invoiced']) {
      expect(isOverduePayment({ status, due_date: '2020-01-01' }, NOW)).toBe(false)
    }
  })
  it('excludes test rows even when otherwise overdue', () => {
    expect(isOverduePayment({ status: 'Overdue', due_date: '2026-01-01', is_test: true }, NOW)).toBe(false)
  })
})

describe('summarizeOverdue', () => {
  it('returns null when nothing is overdue', () => {
    const rows: OverduePaymentRow[] = [
      { status: 'Paid', due_date: '2026-01-01' },
      { status: 'Pending', due_date: '2026-07-30' },
    ]
    expect(summarizeOverdue(rows, NOW)).toBeNull()
  })

  it('aggregates count, oldest days, and total owed across overdue rows', () => {
    const rows: OverduePaymentRow[] = [
      { status: 'Overdue', due_date: '2026-05-31', amount_due: 100 },   // 30 days
      { status: 'Pending', due_date: '2026-06-20', amount: 50 },         // 10 days
      { status: 'Paid', due_date: '2026-01-01', amount_due: 999 },       // ignored
    ]
    expect(summarizeOverdue(rows, NOW)).toEqual({ count: 2, maxDays: 30, totalDue: 150 })
  })

  it('falls back amount_due → amount → total for the owed figure', () => {
    const rows: OverduePaymentRow[] = [
      { status: 'Overdue', due_date: '2026-06-29', total: 75 },
    ]
    expect(summarizeOverdue(rows, NOW)).toEqual({ count: 1, maxDays: 1, totalDue: 75 })
  })

  it('keeps maxDays at 0 for an Overdue row with no due date', () => {
    const rows: OverduePaymentRow[] = [{ status: 'Overdue', due_date: null, amount_due: 40 }]
    expect(summarizeOverdue(rows, NOW)).toEqual({ count: 1, maxDays: 0, totalDue: 40 })
  })
})
