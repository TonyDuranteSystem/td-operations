import { describe, it, expect } from 'vitest'
import {
  PAYMENT_CATEGORIES,
  isPaymentCategory,
  isLivePayment,
  isInstallment,
  isFirstInstallment,
  isSecondInstallment,
  type ClassifiablePayment,
} from '@/lib/billing/payment-classification'

const p = (o: Partial<ClassifiablePayment>): ClassifiablePayment => ({
  payment_category: null,
  year: null,
  status: 'Paid',
  invoice_status: 'Paid',
  ...o,
})

describe('payment-classification — never reads description', () => {
  it('classifies a first installment by structured category + year', () => {
    expect(isFirstInstallment(p({ payment_category: 'installment_1', year: 2026 }), 2026)).toBe(true)
    expect(isSecondInstallment(p({ payment_category: 'installment_2', year: 2026 }), 2026)).toBe(true)
  })

  it('does NOT match the wrong ordinal', () => {
    expect(isFirstInstallment(p({ payment_category: 'installment_2', year: 2026 }), 2026)).toBe(false)
    expect(isSecondInstallment(p({ payment_category: 'installment_1', year: 2026 }), 2026)).toBe(false)
  })

  it('year-scopes when a year is given', () => {
    const row = p({ payment_category: 'installment_2', year: 2025 })
    expect(isSecondInstallment(row, 2026)).toBe(false)
    expect(isSecondInstallment(row, 2025)).toBe(true)
  })

  it('matches any year when year is omitted (reactivation gate use)', () => {
    expect(isSecondInstallment(p({ payment_category: 'installment_2', year: 2024 }))).toBe(true)
    expect(isSecondInstallment(p({ payment_category: 'installment_2', year: null }))).toBe(true)
  })

  it('a Cancelled payment never classifies (either status)', () => {
    expect(isSecondInstallment(p({ payment_category: 'installment_2', year: 2026, status: 'Cancelled' }), 2026)).toBe(false)
    expect(isSecondInstallment(p({ payment_category: 'installment_2', year: 2026, invoice_status: 'Cancelled' }), 2026)).toBe(false)
  })

  it('uncategorized / non-installment categories are not installments', () => {
    for (const cat of [null, 'setup_fee', 'credit', 'one_time', 'custom', 'itin', 'annual_renewal', 'other']) {
      expect(isFirstInstallment(p({ payment_category: cat, year: 2026 }), 2026)).toBe(false)
      expect(isSecondInstallment(p({ payment_category: cat, year: 2026 }), 2026)).toBe(false)
    }
  })

  it('isInstallment is the general form behind the convenience wrappers', () => {
    const row = p({ payment_category: 'installment_1', year: 2026 })
    expect(isInstallment(row, 1, { year: 2026 })).toBe(true)
    expect(isInstallment(row, 1)).toBe(true)
    expect(isInstallment(row, 2, { year: 2026 })).toBe(false)
  })

  it('isLivePayment guards cancelled rows', () => {
    expect(isLivePayment(p({}))).toBe(true)
    expect(isLivePayment(p({ status: 'Cancelled' }))).toBe(false)
    expect(isLivePayment(p({ invoice_status: 'Cancelled' }))).toBe(false)
  })

  it('isLivePayment guards Voided and Credit rows too (widened 2026-09-01, bug-hunter finding)', () => {
    // Before this widening, a Voided installment invoice still counted as "live" here, so the
    // annual-installments cron's duplicate guard treated a voided-and-never-reissued invoice as
    // proof the client was already billed and silently stopped billing them for it forever.
    expect(isLivePayment(p({ invoice_status: 'Voided' }))).toBe(false)
    expect(isLivePayment(p({ invoice_status: 'Credit' }))).toBe(false)
    expect(isSecondInstallment(p({ payment_category: 'installment_2', year: 2026, invoice_status: 'Voided' }), 2026)).toBe(false)
  })

  it('a null invoice_status still counts as live (no false-dead from a missing column)', () => {
    expect(isLivePayment(p({ invoice_status: null }))).toBe(true)
  })

  it('isPaymentCategory is a runtime guard over the known vocabulary', () => {
    expect(PAYMENT_CATEGORIES.every(isPaymentCategory)).toBe(true)
    expect(isPaymentCategory('installment_3')).toBe(false)
    expect(isPaymentCategory(null)).toBe(false)
    expect(isPaymentCategory(undefined)).toBe(false)
  })
})
