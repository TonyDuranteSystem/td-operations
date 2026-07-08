import { describe, it, expect } from 'vitest'
import { mapPaymentStatusToExpense, mirrorDiffers } from '@/lib/portal/td-invoice-mirror'

describe('mapPaymentStatusToExpense', () => {
  it('maps open states to Pending', () => {
    for (const s of ['Draft', 'Sent', 'Pending', 'Partial']) {
      expect(mapPaymentStatusToExpense(s)).toBe('Pending')
    }
  })
  it('keeps Overdue', () => {
    expect(mapPaymentStatusToExpense('Overdue')).toBe('Overdue')
  })
  it('maps Paid and Credit to Paid (a credit note reads as Paid)', () => {
    expect(mapPaymentStatusToExpense('Paid')).toBe('Paid')
    expect(mapPaymentStatusToExpense('Credit')).toBe('Paid')
  })
  it('maps Cancelled/Split/Voided to Cancelled', () => {
    for (const s of ['Cancelled', 'Split', 'Voided']) {
      expect(mapPaymentStatusToExpense(s)).toBe('Cancelled')
    }
  })
  it('defaults null/unknown to Pending / passthrough', () => {
    expect(mapPaymentStatusToExpense(null)).toBe('Pending')
    expect(mapPaymentStatusToExpense(undefined)).toBe('Pending')
    expect(mapPaymentStatusToExpense('Weird')).toBe('Weird')
  })
})

describe('mirrorDiffers', () => {
  const base = { total: 700, amount_due: 700, amount_paid: 0, status: 'Overdue', paid_date: null }

  it('is false when identical (idempotent — no needless write)', () => {
    expect(mirrorDiffers({ ...base }, { ...base })).toBe(false)
  })
  it('detects the Giuseppe drift (mirror 1150 vs payment 700)', () => {
    const mirror = { total: 1150, amount_due: 1150, amount_paid: 0, status: 'Overdue', paid_date: null }
    expect(mirrorDiffers(mirror, base)).toBe(true)
  })
  it('detects a status-only drift', () => {
    expect(mirrorDiffers({ ...base, status: 'Pending' }, base)).toBe(true)
  })
  it('detects an amount_paid drift', () => {
    expect(mirrorDiffers({ ...base, amount_paid: 100 }, base)).toBe(true)
  })
  it('treats null mirror numbers as 0 for comparison', () => {
    const mirror = { total: 0, amount_due: null, amount_paid: null, status: 'Paid', paid_date: null }
    const after = { total: 0, amount_due: 0, amount_paid: 0, status: 'Paid', paid_date: null }
    expect(mirrorDiffers(mirror, after)).toBe(false)
  })
  it('detects a paid_date drift', () => {
    expect(mirrorDiffers({ ...base, paid_date: '2026-01-01' }, base)).toBe(true)
  })
})
