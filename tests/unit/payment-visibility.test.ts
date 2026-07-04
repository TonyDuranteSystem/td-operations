import { describe, it, expect } from 'vitest'
import { isClientVisiblePayment, filterClientVisibleExpenseMirrors } from '@/lib/portal/payment-visibility'

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

describe('filterClientVisibleExpenseMirrors', () => {
  const draftMirror = { id: 'e1', source: 'td_invoice', td_payment_id: 'p1' }
  const sentMirror = { id: 'e2', source: 'td_invoice', td_payment_id: 'p2' }
  const upload = { id: 'e3', source: 'upload', td_payment_id: null }
  const manual = { id: 'e4', source: 'manual', td_payment_id: null }

  const draftPayment = { id: 'p1', invoice_status: 'Draft', status: 'Pending' }
  const sentPayment = { id: 'p2', invoice_status: 'Sent', status: 'Pending' }

  it('hides the mirror of an unsent draft — the Kasabi EXP-000337 case', () => {
    const result = filterClientVisibleExpenseMirrors(
      [draftMirror, sentMirror, upload, manual],
      [draftPayment, sentPayment],
    )
    expect(result.map(e => e.id)).toEqual(['e2', 'e3', 'e4'])
  })

  it('never touches non-TD expenses (uploads, manual)', () => {
    const result = filterClientVisibleExpenseMirrors([upload, manual], [])
    expect(result).toEqual([upload, manual])
  })

  it('fails open: a mirror whose linked payment is missing stays visible', () => {
    const orphanMirror = { id: 'e5', source: 'td_invoice', td_payment_id: 'p-gone' }
    const result = filterClientVisibleExpenseMirrors([orphanMirror], [])
    expect(result).toEqual([orphanMirror])
  })

  it('keeps the mirror of a Draft that was paid anyway', () => {
    const paidDraft = { id: 'p1', invoice_status: 'Draft', status: 'Paid' }
    const result = filterClientVisibleExpenseMirrors([draftMirror], [paidDraft])
    expect(result).toEqual([draftMirror])
  })

  it('returns the input array untouched when nothing is hidden', () => {
    const rows = [sentMirror, upload]
    expect(filterClientVisibleExpenseMirrors(rows, [sentPayment])).toEqual(rows)
  })
})
