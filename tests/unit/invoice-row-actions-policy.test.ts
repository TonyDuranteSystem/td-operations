import { describe, it, expect } from 'vitest'
import { availableInvoiceActions } from '@/lib/portal/invoice-row-actions-policy'

describe('availableInvoiceActions', () => {
  it('Draft → edit, send, void', () => {
    expect(availableInvoiceActions('Draft')).toEqual(['edit', 'send', 'void'])
  })

  it('Sent → remind, void (no edit, no send)', () => {
    expect(availableInvoiceActions('Sent')).toEqual(['remind', 'void'])
  })

  it('Overdue → remind, void', () => {
    expect(availableInvoiceActions('Overdue')).toEqual(['remind', 'void'])
  })

  it('Paid → no actions (cannot void a paid invoice)', () => {
    expect(availableInvoiceActions('Paid')).toEqual([])
  })

  it('Cancelled → no actions (already voided)', () => {
    expect(availableInvoiceActions('Cancelled')).toEqual([])
  })

  it('Partial / Split → no void (backend rejects)', () => {
    expect(availableInvoiceActions('Partial')).toEqual([])
    expect(availableInvoiceActions('Split')).toEqual([])
  })

  it('handles null / empty / unknown / whitespace gracefully', () => {
    expect(availableInvoiceActions(null)).toEqual([])
    expect(availableInvoiceActions(undefined)).toEqual([])
    expect(availableInvoiceActions('')).toEqual([])
    expect(availableInvoiceActions('Bogus')).toEqual([])
    expect(availableInvoiceActions('  Draft  ')).toEqual(['edit', 'send', 'void'])
  })
})
