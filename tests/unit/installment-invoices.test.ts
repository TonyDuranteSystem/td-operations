import { describe, it, expect } from 'vitest'
import { chipForInstallment, findInstallmentInvoice, installmentChip, type InstallmentPaymentRow } from '@/lib/billing/installment-invoices'
import { newYorkToday, newYorkYear } from '@/lib/crm-lists/queries'

type Row = InstallmentPaymentRow & { invoice_status?: string | null; status?: string | null }

const row = (over: Partial<Row> = {}): Row => ({
  payment_category: 'installment_1',
  year: 2026,
  status: 'Pending',
  invoice_status: null,
  total: 1000,
  invoice_number: 'INV-000123',
  ...over,
})

describe('findInstallmentInvoice', () => {
  it('finds the live invoice for that installment and year', () => {
    expect(findInstallmentInvoice([row()], 1, 2026)).toHaveLength(1)
  })
  it('does not mix installments or years', () => {
    expect(findInstallmentInvoice([row({ payment_category: 'installment_2' })], 1, 2026)).toHaveLength(0)
    expect(findInstallmentInvoice([row({ year: 2025 })], 1, 2026)).toHaveLength(0)
  })
  it('ignores cancelled / voided / credit invoices', () => {
    expect(findInstallmentInvoice([row({ status: 'Cancelled' })], 1, 2026)).toHaveLength(0)
    expect(findInstallmentInvoice([row({ invoice_status: 'Voided' })], 1, 2026)).toHaveLength(0)
    expect(findInstallmentInvoice([row({ invoice_status: 'Credit' })], 1, 2026)).toHaveLength(0)
  })
  it('ignores a $0 or numberless companion record', () => {
    expect(findInstallmentInvoice([row({ total: 0 })], 1, 2026)).toHaveLength(0)
    expect(findInstallmentInvoice([row({ invoice_number: null })], 1, 2026)).toHaveLength(0)
    expect(findInstallmentInvoice([row({ invoice_number: '1.0' })], 1, 2026)).toHaveLength(0)
    expect(findInstallmentInvoice([row({ invoice_number: '2.0', payment_category: 'installment_2' })], 2, 2026)).toHaveLength(0)
  })
  it('returns every real match so a duplicate stays visible', () => {
    expect(findInstallmentInvoice([row(), row({ invoice_number: 'INV-000124' })], 1, 2026)).toHaveLength(2)
  })
})

describe('a settled record with no invoice number (March–April 2026 imports, payments marked Paid by hand)', () => {
  const noNumber = (over: Partial<Row> = {}): Row => row({ invoice_number: null, ...over })

  it('counts a Paid / Overdue / Waived record that has an amount but no number', () => {
    expect(findInstallmentInvoice([noNumber({ status: 'Paid' })], 1, 2026)).toHaveLength(1)
    expect(findInstallmentInvoice([noNumber({ status: 'Overdue' })], 1, 2026)).toHaveLength(1)
    expect(findInstallmentInvoice([noNumber({ status: 'Waived' })], 1, 2026)).toHaveLength(1)
    expect(findInstallmentInvoice([noNumber({ invoice_status: 'Delinquent' })], 1, 2026)).toHaveLength(1)
    expect(findInstallmentInvoice([row({ invoice_number: '1.0', status: 'Paid' })], 1, 2026)).toHaveLength(1)
  })
  it('does not count a placeholder: pending, draft, sent or "Not Invoiced" with no number', () => {
    for (const status of ['Pending', 'Draft', 'Sent', 'Not Invoiced']) {
      expect(findInstallmentInvoice([noNumber({ status })], 1, 2026)).toHaveLength(0)
    }
  })
  it('still ignores the $0 companion record, even when it says Paid', () => {
    expect(findInstallmentInvoice([noNumber({ status: 'Paid', total: 0 })], 1, 2026)).toHaveLength(0)
    expect(findInstallmentInvoice([noNumber({ status: 'Paid', total: null })], 1, 2026)).toHaveLength(0)
  })
  it('still ignores a dead record (cancelled / voided / credit)', () => {
    expect(findInstallmentInvoice([noNumber({ status: 'Cancelled' })], 1, 2026)).toHaveLength(0)
    expect(findInstallmentInvoice([noNumber({ status: 'Paid', invoice_status: 'Voided' })], 1, 2026)).toHaveLength(0)
  })
  it('a numbered invoice always wins, so an old unnumbered record beside it is never a duplicate', () => {
    const rows = [noNumber({ status: 'Paid' }), row({ invoice_number: 'INV-000200', status: 'Pending' })]
    const found = findInstallmentInvoice(rows, 1, 2026)
    expect(found).toHaveLength(1)
    expect(found[0].invoice_number).toBe('INV-000200')
    expect(chipForInstallment(rows, 1, 2026)).toEqual({ kind: 'pending', count: 1 })
  })
  it('two settled records with no number are still flagged as a duplicate', () => {
    expect(chipForInstallment([noNumber({ status: 'Paid' }), noNumber({ status: 'Paid' })], 1, 2026)).toEqual({ kind: 'duplicate', count: 2 })
  })
  it('gives the right chip', () => {
    expect(chipForInstallment([noNumber({ status: 'Paid' })], 1, 2026).kind).toBe('paid')
    expect(chipForInstallment([noNumber({ status: 'Overdue' })], 1, 2026).kind).toBe('overdue')
    expect(chipForInstallment([noNumber({ status: 'Waived' })], 1, 2026).kind).toBe('waived')
    expect(chipForInstallment([noNumber({ status: 'Pending' })], 1, 2026).kind).toBe('not_invoiced')
  })
  it('keeps installments and years apart', () => {
    const rows = [noNumber({ status: 'Paid' })]
    expect(chipForInstallment(rows, 2, 2026).kind).toBe('not_invoiced')
    expect(chipForInstallment(rows, 1, 2027).kind).toBe('not_invoiced')
  })
})

describe('installmentChip', () => {
  it('is Not invoiced with no invoice', () => {
    expect(installmentChip([])).toEqual({ kind: 'not_invoiced', count: 0 })
  })
  it('reads the invoice status first, then the payment status', () => {
    expect(installmentChip([row({ invoice_status: 'Paid', status: 'Pending' })]).kind).toBe('paid')
    expect(installmentChip([row({ invoice_status: null, status: 'Paid' })]).kind).toBe('paid')
    expect(installmentChip([row({ invoice_status: null, status: 'Overdue' })]).kind).toBe('overdue')
    expect(installmentChip([row({ invoice_status: 'Delinquent' })]).kind).toBe('overdue')
    expect(installmentChip([row({ invoice_status: null, status: 'Pending' })]).kind).toBe('pending')
    expect(installmentChip([row({ invoice_status: 'Sent', status: 'Pending' })]).kind).toBe('pending')
    expect(installmentChip([row({ invoice_status: null, status: 'Waived' })]).kind).toBe('waived')
    expect(installmentChip([row({ invoice_status: null, status: 'Refunded' })]).kind).toBe('refunded')
  })
  it('flags a duplicate', () => {
    expect(installmentChip([row(), row({ invoice_number: 'INV-000124' })])).toEqual({ kind: 'duplicate', count: 2 })
  })
})

describe('chipForInstallment', () => {
  it('resolves each installment on its own', () => {
    const rows = [row({ status: 'Paid' }), row({ payment_category: 'installment_2', status: 'Overdue' })]
    expect(chipForInstallment(rows, 1, 2026).kind).toBe('paid')
    expect(chipForInstallment(rows, 2, 2026).kind).toBe('overdue')
    expect(chipForInstallment(rows, 1, 2027).kind).toBe('not_invoiced')
  })
})

describe('New York calendar', () => {
  it('uses the New York date, not UTC', () => {
    // 2026-01-01 02:00 UTC is still 31 Dec 2025 evening in New York
    expect(newYorkToday(new Date('2026-01-01T02:00:00Z'))).toBe('2025-12-31')
    expect(newYorkYear(new Date('2026-01-01T02:00:00Z'))).toBe(2025)
    expect(newYorkYear(new Date('2026-01-01T06:00:00Z'))).toBe(2026)
  })
})
