import { describe, it, expect } from 'vitest'
import { isClientVisiblePayment } from '@/lib/portal/payment-visibility'

describe('isClientVisiblePayment', () => {
  it('hides an unsent draft (Draft + Pending) — the Kasabi INV-002172 case', () => {
    expect(isClientVisiblePayment({ invoice_status: 'Draft', status: 'Pending' })).toBe(false)
  })

  it('keeps a Draft that was paid anyway (real history must stay visible)', () => {
    expect(isClientVisiblePayment({ invoice_status: 'Draft', status: 'Paid' })).toBe(true)
  })

  it('keeps sent invoices in every payment state', () => {
    expect(isClientVisiblePayment({ invoice_status: 'Sent', status: 'Pending' })).toBe(true)
    expect(isClientVisiblePayment({ invoice_status: 'Overdue', status: 'Overdue' })).toBe(true)
    expect(isClientVisiblePayment({ invoice_status: 'Paid', status: 'Paid' })).toBe(true)
  })

  it('keeps legacy rows with no invoice_status regardless of payment status', () => {
    expect(isClientVisiblePayment({ invoice_status: null, status: 'Pending' })).toBe(true)
    expect(isClientVisiblePayment({ invoice_status: null, status: 'Paid' })).toBe(true)
    expect(isClientVisiblePayment({ invoice_status: null, status: 'Not Invoiced' })).toBe(true)
    expect(isClientVisiblePayment({})).toBe(true)
  })

  it('keeps cancelled invoices (they render with their own badge; hiding them is not this helper decision)', () => {
    expect(isClientVisiblePayment({ invoice_status: 'Cancelled', status: 'Cancelled' })).toBe(true)
  })
})
