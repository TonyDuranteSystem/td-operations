import { describe, it, expect } from 'vitest'
import { parseInvoiceDescription, chosenInvoiceDescription, INVOICE_DESCRIPTION_MAX } from '@/lib/offers/invoice-description'
import { decideSigningBill } from '@/lib/offers/payment-plan'

describe('parseInvoiceDescription', () => {
  it('empty, blank or missing = not set', () => {
    for (const v of [undefined, null, '', '   ', '\n\t ']) expect(parseInvoiceDescription(v)).toEqual({ value: null })
  })
  it('trims, turns line breaks into spaces and collapses runs of spaces', () => {
    expect(parseInvoiceDescription('  LLC formation   for\nBlue Corp\t ')).toEqual({ value: 'LLC formation for Blue Corp' })
  })
  it('removes control characters', () => {
    expect(parseInvoiceDescription('Form\u0000ation\u007f')).toEqual({ value: 'Formation' })
  })
  it('keeps accents and symbols as typed', () => {
    expect(parseInvoiceDescription('Costituzione LLC — Wyoming (Blue Corp) #1')).toEqual({ value: 'Costituzione LLC — Wyoming (Blue Corp) #1' })
  })
  it('refuses text that is not a string, and text that is too long', () => {
    expect(parseInvoiceDescription(42).error).toMatch(/must be text/)
    expect(parseInvoiceDescription({}).error).toMatch(/must be text/)
    expect(parseInvoiceDescription('x'.repeat(INVOICE_DESCRIPTION_MAX)).value).toHaveLength(INVOICE_DESCRIPTION_MAX)
    expect(parseInvoiceDescription('x'.repeat(INVOICE_DESCRIPTION_MAX + 1)).error).toMatch(/at most 200/)
  })
})

describe('chosenInvoiceDescription', () => {
  it('returns the saved wording, trimmed, or null to use the automatic text', () => {
    expect(chosenInvoiceDescription({ invoice_description: '  Formation  ' })).toBe('Formation')
    expect(chosenInvoiceDescription({ invoice_description: '   ' })).toBeNull()
    expect(chosenInvoiceDescription({ invoice_description: null })).toBeNull()
    expect(chosenInvoiceDescription({})).toBeNull()
    expect(chosenInvoiceDescription(null)).toBeNull()
    expect(chosenInvoiceDescription({ invoice_description: 5 })).toBeNull()
  })
})

describe('the chosen wording becomes the signing invoice text', () => {
  it('an ordinary offer bills exactly the chosen text', () => {
    const b = decideSigningBill({ rawPlan: null, offerToken: 't', offerGross: 1000, baseDescription: 'LLC formation for Blue Corp' })
    expect(b.description).toBe('LLC formation for Blue Corp')
  })
})
