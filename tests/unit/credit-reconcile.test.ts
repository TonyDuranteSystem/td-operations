import { describe, it, expect } from 'vitest'
import { allocateCredits, type InvoiceNeed, type CreditAvail } from '@/lib/operations/credit-netting'

describe('allocateCredits — FIFO, same-currency credit application', () => {
  it('applies a partial credit to one invoice (Growly: $200 credit on $1000 due)', () => {
    const inv: InvoiceNeed[] = [{ id: 'i1', amountDue: 1000, currency: 'USD' }]
    const cr: CreditAvail[] = [{ id: 'c1', remaining: 200, currency: 'USD' }]
    expect(allocateCredits(inv, cr)).toEqual([{ invoiceId: 'i1', creditId: 'c1', amount: 200 }])
  })

  it('a credit larger than the invoice only applies up to the amount due', () => {
    const inv: InvoiceNeed[] = [{ id: 'i1', amountDue: 300, currency: 'USD' }]
    const cr: CreditAvail[] = [{ id: 'c1', remaining: 500, currency: 'USD' }]
    expect(allocateCredits(inv, cr)).toEqual([{ invoiceId: 'i1', creditId: 'c1', amount: 300 }])
  })

  it('spreads one credit across multiple invoices oldest-first, stops when exhausted', () => {
    const inv: InvoiceNeed[] = [
      { id: 'i1', amountDue: 100, currency: 'USD' },
      { id: 'i2', amountDue: 100, currency: 'USD' },
      { id: 'i3', amountDue: 100, currency: 'USD' },
    ]
    const cr: CreditAvail[] = [{ id: 'c1', remaining: 250, currency: 'USD' }]
    expect(allocateCredits(inv, cr)).toEqual([
      { invoiceId: 'i1', creditId: 'c1', amount: 100 },
      { invoiceId: 'i2', creditId: 'c1', amount: 100 },
      { invoiceId: 'i3', creditId: 'c1', amount: 50 },
    ])
  })

  it('uses multiple credits on one invoice, oldest credit first', () => {
    const inv: InvoiceNeed[] = [{ id: 'i1', amountDue: 500, currency: 'USD' }]
    const cr: CreditAvail[] = [
      { id: 'c1', remaining: 200, currency: 'USD' },
      { id: 'c2', remaining: 400, currency: 'USD' },
    ]
    expect(allocateCredits(inv, cr)).toEqual([
      { invoiceId: 'i1', creditId: 'c1', amount: 200 },
      { invoiceId: 'i1', creditId: 'c2', amount: 300 },
    ])
  })

  it('never applies a credit across currencies', () => {
    const inv: InvoiceNeed[] = [{ id: 'i1', amountDue: 1000, currency: 'USD' }]
    const cr: CreditAvail[] = [{ id: 'c1', remaining: 500, currency: 'EUR' }]
    expect(allocateCredits(inv, cr)).toEqual([])
  })

  it('no invoices or no credits → nothing applied', () => {
    expect(allocateCredits([], [{ id: 'c1', remaining: 100, currency: 'USD' }])).toEqual([])
    expect(allocateCredits([{ id: 'i1', amountDue: 100, currency: 'USD' }], [])).toEqual([])
  })

  it('rounds to cents', () => {
    const inv: InvoiceNeed[] = [{ id: 'i1', amountDue: 100.005, currency: 'USD' }]
    const cr: CreditAvail[] = [{ id: 'c1', remaining: 100.005, currency: 'USD' }]
    const out = allocateCredits(inv, cr)
    expect(out[0].amount).toBe(100.01)
  })
})
