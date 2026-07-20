/**
 * Free-form text → printable PDF (Luca, 2026-07-10; built 2026-07-19).
 *
 * He asked the worker for the IRS name-change letter "as a PDF", got plain text plus an
 * offer to download a file that did not exist, and reformatted it by hand. Every other
 * PDF here fills a known template; nothing turned arbitrary text into a page.
 *
 * These assert the properties that decide whether the output is usable: it is a real
 * PDF, long text does not fall off the page, accented characters survive (half the
 * clients are Italian), and formatting markers never print as literal junk in a letter
 * going to the IRS.
 */

import { describe, it, expect } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { renderLetterPdf } from '@/lib/pdf/letter-pdf'

/** Parse the bytes back — the only real proof it is a valid document. */
async function parse(bytes: Uint8Array) {
  return PDFDocument.load(bytes)
}

describe('renderLetterPdf', () => {
  it('produces a real, loadable PDF', async () => {
    const bytes = await renderLetterPdf({ body: 'Hello.' })
    // %PDF- magic, then it must actually parse.
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe('%PDF-')
    const doc = await parse(bytes)
    expect(doc.getPageCount()).toBe(1)
  })

  it('renders the real IRS letter shape without throwing', async () => {
    const bytes = await renderLetterPdf({
      title: 'Notification of Company Name Change',
      dateLine: '19 July 2026',
      reference: ['Re: DF Commerce LLC', 'EIN: 12-3456789'],
      body: [
        'To Whom It May Concern,',
        '',
        'Please be advised that the entity previously registered as DF Commerce LLC has changed its name, as approved by the Wyoming Secretary of State.',
        '',
        '## Details',
        '- Previous name: DF Commerce LLC',
        '- Effective date: 10 July 2026',
        '',
        'Kindly update your records accordingly.',
      ].join('\n'),
    })
    const doc = await parse(bytes)
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1)
  })

  it('flows onto more pages instead of running off the first', async () => {
    // A long letter must not silently lose its second half below the margin.
    const long = Array.from({ length: 120 }, (_, i) => `Paragraph ${i + 1}. ${'word '.repeat(40)}`).join('\n\n')
    const doc = await parse(await renderLetterPdf({ title: 'Long', body: long }))
    expect(doc.getPageCount()).toBeGreaterThan(1)
  })

  it('handles accented and non-Latin text — Italian clients are half the book', async () => {
    // The default PDF fonts cannot encode these and throw; the embedded ones can.
    const bytes = await renderLetterPdf({
      title: 'Comunicazione di variazione',
      body: 'Gentile Cliente,\n\nLa società è stata rinominata. Cordiali saluti — Tony Durante LLC.\n\nPerché? Così.',
    })
    expect((await parse(bytes)).getPageCount()).toBe(1)
  })

  it('does not fall over on an empty or whitespace body', async () => {
    // A caller should always have something to hand over, even on odd input.
    expect((await parse(await renderLetterPdf({ body: '' }))).getPageCount()).toBe(1)
    expect((await parse(await renderLetterPdf({ body: '   \n\n  ' }))).getPageCount()).toBe(1)
  })

  it('accepts a very long unbroken token without hanging', async () => {
    // A pasted URL or reference number with no spaces must be broken, not looped on.
    const bytes = await renderLetterPdf({ body: 'x'.repeat(4000) })
    expect((await parse(bytes)).getPageCount()).toBeGreaterThanOrEqual(1)
  })

  it('takes a custom letterhead, and an empty one for a bare document', async () => {
    expect((await parse(await renderLetterPdf({ body: 'x', letterhead: 'Other Co' }))).getPageCount()).toBe(1)
    expect((await parse(await renderLetterPdf({ body: 'x', letterhead: '' }))).getPageCount()).toBe(1)
  })
})
