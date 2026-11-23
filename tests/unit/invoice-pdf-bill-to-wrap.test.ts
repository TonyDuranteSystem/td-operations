/**
 * The "Bill to" block of a TD invoice PDF can carry text typed by a client on the payment page (name up to 120, address up to
 * 200, VAT up to 40 characters). It used to be drawn on ONE line and ran off the right edge of the sheet (dev job e62bc2b6,
 * bug-hunter follow-up). It must wrap inside the page, and odd characters must never stop the PDF from being made.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { PDFDocument, PDFPage } from 'pdf-lib'
import { generateInvoicePdf, type InvoicePdfInput } from '@/lib/pdf/invoice-pdf'

const base = (billTo: InvoicePdfInput['billTo']): InvoicePdfInput => ({
  companyName: 'Tony Durante LLC',
  documentType: 'INVOICE',
  invoiceNumber: 'INV-1',
  status: 'Sent',
  currency: 'USD',
  issueDate: '2026-11-23',
  dueDate: '2026-12-23',
  billTo,
  items: [{ description: 'Service', quantity: 1, unit_price: 100, amount: 100 }],
  subtotal: 100,
  discount: 0,
  total: 100,
})

type Drawn = { text: string; x: number; width: number }
function captureDraws() {
  const drawn: Drawn[] = []
  const spy = vi.spyOn(PDFPage.prototype, 'drawText').mockImplementation(function (this: PDFPage, text: string, options?: { x?: number; size?: number; font?: { widthOfTextAtSize: (t: string, s: number) => number } }) {
    if (options?.font && options.size) drawn.push({ text, x: options.x ?? 0, width: options.font.widthOfTextAtSize(text, options.size) })
    return this
  })
  return { drawn, spy }
}

afterEach(() => { vi.restoreAllMocks() })

describe('TD invoice PDF — the Bill to block stays inside the page', () => {
  it('a 120-character name, a 200-character address and a long VAT number wrap instead of running off the edge', async () => {
    const { drawn } = captureDraws()
    const bytes = await generateInvoicePdf(base({
      name: 'Very Long Company Name Holdings International Trading '.repeat(3).slice(0, 120).trim(),
      email: 'billing@example.test',
      address: '25 Vitosha Boulevard, Sofia Center District, Sofia Region, Bulgaria, European Union, Building B, Floor 4, Office 12 '.repeat(2).slice(0, 200).trim(),
      vatNumber: 'BG206700239 BG206700239 BG206700239 BG206700239',
    }))
    expect(bytes.length).toBeGreaterThan(500)
    const billToLines = drawn.filter((d) => d.x === 50 && /Vitosha|Company Name|BG2067/.test(d.text))
    expect(billToLines.length).toBeGreaterThan(3) // wrapped onto several lines
    for (const l of billToLines) expect(50 + l.width).toBeLessThanOrEqual(545)
    // the whole text is still there (nothing silently dropped within the line caps)
    expect(billToLines.map((l) => l.text).join(' ')).toContain('Vitosha')
  })

  it('a short payer is drawn exactly as before: one line each', async () => {
    const { drawn } = captureDraws()
    await generateInvoicePdf(base({ name: 'Maria Rossi', address: 'Via Roma 1, Milano', vatNumber: 'IT123' }))
    expect(drawn.filter((d) => d.text === 'Maria Rossi')).toHaveLength(1)
    expect(drawn.filter((d) => d.text === 'Via Roma 1, Milano')).toHaveLength(1)
    expect(drawn.filter((d) => d.text === 'VAT: IT123')).toHaveLength(1)
  })

  it('accents, Cyrillic, Arabic and emoji in a typed name never stop the PDF from being made', async () => {
    for (const name of ['Société Générale Müller Ñandú', 'ООО Ромашка', 'شركة المثال', '日本語の会社 😀 LLC', 'Zażółć gęślą jaźń Sp. z o.o.']) {
      const bytes = await generateInvoicePdf(base({ name, address: `${name} street`, vatNumber: 'X1' }))
      const doc = await PDFDocument.load(bytes)
      expect(doc.getPageCount()).toBeGreaterThanOrEqual(1)
    }
  })

  it('one huge word with no spaces is cut to fit, not drawn off the page', async () => {
    const { drawn } = captureDraws()
    await generateInvoicePdf(base({ name: 'N'.repeat(120), address: 'A'.repeat(200) }))
    const longLines = drawn.filter((d) => d.x === 50 && /^[NA]{5,}/.test(d.text))
    expect(longLines.length).toBeGreaterThan(1)
    for (const l of longLines) expect(50 + l.width).toBeLessThanOrEqual(545)
  })
})
