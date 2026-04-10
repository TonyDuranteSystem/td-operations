import { describe, it, expect } from 'vitest'
import { createInvoiceSchema } from '@/lib/schemas/invoice'

describe('createInvoiceSchema — mark_as_paid', () => {
  const baseInput = {
    account_id: '502f86f1-f374-4a9d-b2e3-c3a4b36e8e9b',
    description: 'Company Formation',
    amount_currency: 'USD' as const,
    issue_date: '2026-04-10',
    items: [{ description: 'Formation fee', quantity: 1, unit_price: 1000, amount: 1000, sort_order: 0 }],
  }

  it('accepts mark_as_paid=true', () => {
    const result = createInvoiceSchema.safeParse({ ...baseInput, mark_as_paid: true })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.mark_as_paid).toBe(true)
    }
  })

  it('accepts mark_as_paid=false', () => {
    const result = createInvoiceSchema.safeParse({ ...baseInput, mark_as_paid: false })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.mark_as_paid).toBe(false)
    }
  })

  it('defaults mark_as_paid to undefined when omitted', () => {
    const result = createInvoiceSchema.safeParse(baseInput)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.mark_as_paid).toBeUndefined()
    }
  })

  it('rejects mark_as_paid with non-boolean value', () => {
    const result = createInvoiceSchema.safeParse({ ...baseInput, mark_as_paid: 'yes' })
    expect(result.success).toBe(false)
  })
})
