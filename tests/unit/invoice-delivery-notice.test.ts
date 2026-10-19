import { describe, it, expect } from 'vitest'
import { buildDeliveryNotice } from '@/lib/portal/invoice-delivery-notice'

describe('the "not delivered" notice to the client', () => {
  const base = { invoiceNumber: 'INV-002671', customerName: 'K&A S.R.L.', to: 'renato@example.it' }
  it('names the invoice, the customer and the address in both languages', () => {
    const n = buildDeliveryNotice({ ...base, detail: 'suppressed' })
    expect(n.title.en).toBe('Invoice INV-002671 did not reach your customer')
    expect(n.title.it).toBe('La fattura INV-002671 non è arrivata al tuo cliente')
    expect(n.message.en).toContain('K&A S.R.L. (renato@example.it)')
    expect(n.message.it).toContain('K&A S.R.L. (renato@example.it)')
    expect(n.ctaLabel).toEqual({ en: 'Open the invoice', it: 'Apri la fattura' })
  })
  it('gives the reason that matches what Resend reported', () => {
    expect(buildDeliveryNotice({ ...base, detail: 'suppressed' }).message.en).toContain('currently blocked')
    expect(buildDeliveryNotice({ ...base, detail: 'bounced' }).message.en).toContain('misspelled, closed or full')
    expect(buildDeliveryNotice({ ...base, detail: 'failed' }).message.en).toContain('could not be sent')
    expect(buildDeliveryNotice({ ...base, detail: null }).message.it).toContain('Non è stato possibile inviare')
  })
  it('always says what to do next', () => {
    const n = buildDeliveryNotice({ ...base, detail: 'bounced' })
    expect(n.message.en).toContain('download the PDF and send it yourself')
    expect(n.message.it).toContain('scarica il PDF e invialo tu')
  })
  it('still reads well without a customer name or address', () => {
    expect(buildDeliveryNotice({ ...base, customerName: null, detail: 'failed' }).message.en).toContain('to renato@example.it could not')
    expect(buildDeliveryNotice({ invoiceNumber: 'INV-1', customerName: null, to: null, detail: 'failed' }).message.en).toContain('to your customer could not')
    expect(buildDeliveryNotice({ ...base, to: null, detail: 'failed' }).message.en).toContain('to K&A S.R.L. could not')
  })
})
