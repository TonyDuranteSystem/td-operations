import { describe, it, expect } from 'vitest'
import { INVOICE_STATUS, invoiceStatusRule, pdfStatusForSend, resolvePdfStatus } from '@/lib/portal/invoice-status'
import { availableInvoiceActions } from '@/lib/portal/invoice-row-actions-policy'

describe('invoice status table', () => {
  it('stamps every status except Sent and Split; Sent is the clean invoice', () => {
    expect(INVOICE_STATUS.Sent.watermark).toBeNull()
    expect(INVOICE_STATUS.Draft.watermark?.text).toBe('DRAFT')
    expect(INVOICE_STATUS.Paid.watermark?.text).toBe('PAID')
    expect(INVOICE_STATUS.Overdue.watermark?.text).toBe('OVERDUE')
    expect(INVOICE_STATUS.Partial.watermark?.text).toBe('PARTIAL')
    expect(INVOICE_STATUS.Cancelled.watermark?.text).toBe('CANCELLED')
  })

  it('only a Draft can be sent; only Sent/Overdue can be reminded', () => {
    const sendable = Object.entries(INVOICE_STATUS).filter(([, r]) => r.sendable).map(([k]) => k)
    const remindable = Object.entries(INVOICE_STATUS).filter(([, r]) => r.remindable).map(([k]) => k).sort()
    expect(sendable).toEqual(['Draft'])
    expect(remindable).toEqual(['Overdue', 'Sent'])
  })

  it('Cancelled and Split cannot be edited or voided', () => {
    for (const s of ['Cancelled', 'Split']) {
      expect(INVOICE_STATUS[s].editable).toBe(false)
      expect(INVOICE_STATUS[s].voidable).toBe(false)
    }
  })

  it('unknown or empty status has no rule', () => {
    expect(invoiceStatusRule('Nonsense')).toBeNull()
    expect(invoiceStatusRule(null)).toBeNull()
    expect(invoiceStatusRule(' Draft ')?.sendable).toBe(true)
  })
})

describe('the PDF the customer receives', () => {
  it('a Draft is rendered as Sent for the email, nothing else changes', () => {
    expect(pdfStatusForSend('Draft')).toBe('Sent')
    expect(pdfStatusForSend('Sent')).toBe('Sent')
    expect(pdfStatusForSend('Paid')).toBe('Paid')
    expect(pdfStatusForSend('Overdue')).toBe('Overdue')
    expect(pdfStatusForSend(null)).toBe('')
  })

  it('?as=Sent is honoured only for a Draft', () => {
    expect(resolvePdfStatus('Draft', 'Sent')).toBe('Sent')
    expect(resolvePdfStatus('Paid', 'Sent')).toBe('Paid')
    expect(resolvePdfStatus('Cancelled', 'Sent')).toBe('Cancelled')
    expect(resolvePdfStatus('Draft', 'Paid')).toBe('Draft')
    expect(resolvePdfStatus('Draft', null)).toBe('Draft')
    expect(resolvePdfStatus('Draft', undefined)).toBe('Draft')
  })

  it('the stamp on a Draft sent as Sent is clean', () => {
    expect(invoiceStatusRule(pdfStatusForSend('Draft'))?.watermark).toBeNull()
  })
})

describe('row actions still follow the table', () => {
  it('keeps the previous behaviour per status', () => {
    expect(availableInvoiceActions('Draft')).toEqual(['edit', 'send', 'void'])
    expect(availableInvoiceActions('Sent')).toEqual(['edit', 'remind', 'void'])
    expect(availableInvoiceActions('Overdue')).toEqual(['edit', 'remind', 'void'])
    expect(availableInvoiceActions('Paid')).toEqual(['edit', 'void'])
    expect(availableInvoiceActions('Partial')).toEqual(['edit', 'void'])
    expect(availableInvoiceActions('Cancelled')).toEqual([])
    expect(availableInvoiceActions('Split')).toEqual([])
    expect(availableInvoiceActions(null)).toEqual([])
  })
})
