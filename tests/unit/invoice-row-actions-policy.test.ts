import { describe, it, expect } from 'vitest'
import { availableInvoiceActions } from '@/lib/portal/invoice-row-actions-policy'

describe('availableInvoiceActions', () => {
  it('Draft → edit, send, void', () => {
    expect(availableInvoiceActions('Draft')).toEqual(['edit', 'send', 'void'])
  })

  it('Sent → edit, remind, void (no send)', () => {
    expect(availableInvoiceActions('Sent')).toEqual(['edit', 'remind', 'void'])
  })

  it('Overdue → edit, remind, void', () => {
    expect(availableInvoiceActions('Overdue')).toEqual(['edit', 'remind', 'void'])
  })

  it('Paid → edit, void (client can edit/void their own paid invoice; no reminder)', () => {
    expect(availableInvoiceActions('Paid')).toEqual(['edit', 'void'])
  })

  it('Partial → edit, void', () => {
    expect(availableInvoiceActions('Partial')).toEqual(['edit', 'void'])
  })

  it('Split → no actions (structural parent of installments)', () => {
    expect(availableInvoiceActions('Split')).toEqual([])
  })

  it('Cancelled → no actions (already voided)', () => {
    expect(availableInvoiceActions('Cancelled')).toEqual([])
  })

  it('handles null / empty / unknown / whitespace gracefully', () => {
    expect(availableInvoiceActions(null)).toEqual([])
    expect(availableInvoiceActions(undefined)).toEqual([])
    expect(availableInvoiceActions('')).toEqual([])
    expect(availableInvoiceActions('Bogus')).toEqual([])
    expect(availableInvoiceActions('  Paid  ')).toEqual(['edit', 'void'])
  })
})
