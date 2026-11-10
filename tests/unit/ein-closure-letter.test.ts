import { describe, it, expect } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import {
  buildEinClosureLetterPdf,
  einClosureLetterLines,
  einClosureLetterProblems,
  letterDateText,
  EIN_LETTER_REPLY_ADDRESS_LINES,
  EIN_LETTER_CONTACT,
  type EinClosureLetterInput,
} from '@/lib/closure/ein-closure-letter'

const base: EinClosureLetterInput = {
  companyName: 'ITALYFLOW LLC',
  ein: '41-2330246',
  companyAddressLines: ['1209 Mountain Road PL NE Ste R', 'Albuquerque, NM 87110'],
  signerName: 'Christian Ranieri',
  date: new Date('2026-11-04T15:00:00Z'),
  includesEinNotice: true,
}

// A valid 1x1 transparent PNG (the shape of a drawn signature export).
const PNG_1X1 = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'))

describe('einClosureLetterLines — the wording every past closure letter used', () => {
  it('has the same fields, in the same order, as the letters already sent to the IRS', () => {
    const l = einClosureLetterLines(base)
    expect(l.fields.map((f) => f.label)).toEqual(['To:', 'Request:', 'Name/Business Name:', 'Mailing Address:', 'EIN'])
    expect(l.fields[0].lines).toEqual(['Internal Revenue Service'])
    expect(l.fields[1].lines).toEqual(['Close Business Account/Cancel EIN'])
    expect(l.fields[2].lines).toEqual(['ITALYFLOW LLC'])
    expect(l.fields[3].lines).toEqual(['1209 Mountain Road PL NE Ste R', 'Albuquerque, NM 87110'])
    expect(l.fields[4].lines).toEqual(['41-2330246'])
  })

  it('says the three sentences of the template (the copy sentence only when a copy is attached)', () => {
    const withCopy = einClosureLetterLines(base).body
    expect(withCopy).toEqual([
      'Please close the business account associated with the EIN listed above. I am no longer using this account.',
      'Please let me know if you have any questions or need anything else.',
      'I have included a copy of the original EIN Assignment /Confirmation Letter.',
    ])
    const without = einClosureLetterLines({ ...base, includesEinNotice: false }).body
    expect(without).toHaveLength(2)
    expect(without.join(' ')).not.toMatch(/included a copy/)
  })

  it('asks for the confirmation at our official Largo address and signs with the owner, TD phone and support mailbox', () => {
    const l = einClosureLetterLines(base)
    expect(l.replyIntro).toBe('Please mail a confirmation letter to the address listed below.')
    expect(l.replyLines).toEqual(['10225 Ulmerton Rd 3D', 'Largo, FL 33771'])
    expect(EIN_LETTER_REPLY_ADDRESS_LINES).toEqual(l.replyLines)
    expect(l.signer).toEqual(['Name: Christian Ranieri', 'Phone: 727-452-1093', 'Email: support@tonydurante.us'])
    expect(EIN_LETTER_CONTACT.email).toBe('support@tonydurante.us')
  })

  it('trims what the client typed and drops empty address lines', () => {
    const l = einClosureLetterLines({ ...base, companyName: '  Doctor Veg LLC ', ein: ' 30-1418982 ', companyAddressLines: [' 1 Main St ', '', '  '] })
    expect(l.fields[2].lines).toEqual(['Doctor Veg LLC'])
    expect(l.fields[3].lines).toEqual(['1 Main St'])
    expect(l.fields[4].lines).toEqual(['30-1418982'])
  })
})

describe('letterDateText', () => {
  it('prints the US date in New York time', () => {
    expect(letterDateText(new Date('2026-11-04T15:00:00Z'))).toBe('11/04/2026')
  })
  it('does not roll to tomorrow after 8 pm New York time (UTC is already the next day)', () => {
    expect(letterDateText(new Date('2026-11-05T02:30:00Z'))).toBe('11/04/2026')
  })
})

describe('einClosureLetterProblems', () => {
  it('is empty when everything the IRS wants is there', () => {
    expect(einClosureLetterProblems(base)).toEqual([])
  })
  it('names each missing piece in plain words', () => {
    const p = einClosureLetterProblems({ companyName: ' ', ein: '12', companyAddressLines: [' '], signerName: '' })
    expect(p).toHaveLength(4)
    expect(p.join(' ')).toMatch(/legal name/)
    expect(p.join(' ')).toMatch(/9 digits/)
    expect(p.join(' ')).toMatch(/address/)
    expect(p.join(' ')).toMatch(/signer/)
  })
  it('accepts an EIN without the dash', () => {
    expect(einClosureLetterProblems({ ...base, ein: '412330246' })).toEqual([])
  })
})

describe('buildEinClosureLetterPdf', () => {
  it('makes a one-page US Letter PDF', async () => {
    const bytes = await buildEinClosureLetterPdf(base)
    const doc = await PDFDocument.load(bytes)
    expect(doc.getPageCount()).toBe(1)
    const { width, height } = doc.getPage(0).getSize()
    expect([width, height]).toEqual([612, 792])
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe('%PDF-')
  })

  it('accepts a drawn signature and stays one page', async () => {
    const withSig = await buildEinClosureLetterPdf({ ...base, signaturePng: PNG_1X1 })
    const without = await buildEinClosureLetterPdf(base)
    expect((await PDFDocument.load(withSig)).getPageCount()).toBe(1)
    expect(withSig.length).toBeGreaterThan(without.length) // the image is in there
  })

  it('prints a name with accents (Italian clients)', async () => {
    const bytes = await buildEinClosureLetterPdf({ ...base, signerName: 'Niccolò D’Angelo' })
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1)
  })

  it('refuses to make a letter with a gap the IRS would bounce (no address)', async () => {
    await expect(buildEinClosureLetterPdf({ ...base, companyAddressLines: [] })).rejects.toThrow(/address is missing/)
  })
})
