import { describe, it, expect } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { embedUnicodeFonts } from '@/lib/pdf/unicode-fonts'
import {
  buildEinClosureLetter,
  planLetter,
  PAGE_W,
  MARGIN,
  MIN_BASELINE,
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

  it('asks for the confirmation at our SEMINOLE office (not Largo) and signs with the owner, TD phone and support mailbox', () => {
    const l = einClosureLetterLines(base)
    expect(l.replyIntro).toBe('Please mail a confirmation letter to the address listed below.')
    expect(l.replyLines).toEqual(['11125 Park Blvd, Suite 104-153', 'Seminole, FL 33772'])
    expect(l.replyLines.join(' ')).not.toMatch(/Ulmerton|Largo/)
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

describe('the letter always fits ONE page and nothing runs off it', () => {
  const longAddress = ['1209 Mountain Road PL NE Ste R Building Twelve Floor Three Room Nine Attention Corporate Records', 'Albuquerque, NM 87110']
  async function plan(input: EinClosureLetterInput, k = 1) {
    const pdf = await PDFDocument.create()
    const fonts = await embedUnicodeFonts(pdf)
    return { fonts, ...planLetter(einClosureLetterLines(input), fonts, k) }
  }

  it('a long address line WRAPS inside the answer column (it used to be cut at the page edge)', async () => {
    const { ops, fonts } = await plan({ ...base, companyAddressLines: longAddress })
    for (const op of ops) {
      if (op.t !== 'text') continue
      const font = op.bold ? fonts.bold : fonts.regular
      expect(op.x + font.widthOfTextAtSize(op.text, op.size)).toBeLessThanOrEqual(PAGE_W - MARGIN + 0.5)
    }
    const words = ops.filter((o) => o.t === 'text').map((o) => (o as { text: string }).text).join(' ')
    expect(words).toContain('Attention Corporate Records') // the end of the line is still there
    expect(words).toContain('Albuquerque, NM 87110')
  })

  it('a long company name wraps too', async () => {
    const name = 'The International Association of Extremely Long Company Names and Other Associated Holdings LLC'
    const { ops, fonts } = await plan({ ...base, companyName: name })
    expect(ops.filter((o) => o.t === 'text' && (o as { x: number }).x >= 230 && !(o as { bold: boolean }).bold).length).toBeGreaterThan(2)
    for (const op of ops) {
      if (op.t !== 'text') continue
      expect(op.x + (op.bold ? fonts.bold : fonts.regular).widthOfTextAtSize(op.text, op.size)).toBeLessThanOrEqual(PAGE_W - MARGIN + 0.5)
    }
  })

  it('every line of a six-line address is printed, and the signature and name stay above the bottom margin', async () => {
    const six = ['c/o Registered Agent Services Inc.', 'Attn: Corporate Records Department', '1209 Mountain Road PL NE Ste R', 'Building 12, Floor 3', 'Albuquerque, NM 87110', 'United States of America']
    const bytes = await buildEinClosureLetterPdf({ ...base, companyAddressLines: six })
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1)
    const { ops } = await plan({ ...base, companyAddressLines: six })
    const text = ops.filter((o) => o.t === 'text').map((o) => (o as { text: string }).text)
    for (const line of six) expect(text).toContain(line)
    expect(Math.min(...ops.filter((o) => o.t === 'text').map((o) => o.y))).toBeGreaterThanOrEqual(MIN_BASELINE)
  })

  it('the worst case that is allowed (six long lines + a long name) still ends on one page', async () => {
    const worst = Array.from({ length: 6 }, (_, n) => `${n + 1} ${'Very Long Street Name '.repeat(5)}`.slice(0, 118))
    const bytes = await buildEinClosureLetterPdf({ ...base, companyName: 'X'.repeat(30) + ' ' + 'Y'.repeat(30) + ' LLC', companyAddressLines: worst })
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1)
  })
})

describe('what the letter refuses to print wrongly', () => {
  it('seven address lines, or a line over 120 characters, are refused with a plain sentence', () => {
    expect(einClosureLetterProblems({ ...base, companyAddressLines: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }).join(' ')).toMatch(/7 lines.*room for 6/)
    expect(einClosureLetterProblems({ ...base, companyAddressLines: ['x'.repeat(121)] }).join(' ')).toMatch(/longer than 120/)
    expect(einClosureLetterProblems({ ...base, companyAddressLines: ['x'.repeat(120)] })).toEqual([])
    expect(einClosureLetterProblems({ ...base, companyName: 'x'.repeat(151) }).join(' ')).toMatch(/longer than 150/)
  })

  it('right-to-left writing is refused (it would print in the wrong order)', () => {
    expect(einClosureLetterProblems({ ...base, companyName: 'شركة LLC' }).join(' ')).toMatch(/right-to-left/)
    expect(einClosureLetterProblems({ ...base, companyAddressLines: ['רחוב 1'] }).join(' ')).toMatch(/right-to-left/)
  })

  it('characters the font has no picture for are refused with the characters named; accents print', async () => {
    await expect(buildEinClosureLetterPdf({ ...base, companyAddressLines: ['北京 1 Main St'] })).rejects.toThrow(/cannot print these characters: "北" "京"/)
    await expect(buildEinClosureLetterPdf({ ...base, companyName: 'Café Città Ünïcödé LLC' })).resolves.toBeInstanceOf(Uint8Array)
  })

  it('stray control characters (a carriage return, a form feed, a tab) are blanks, never extra lines drawn on top of each other', () => {
    const l = einClosureLetterLines({ ...base, companyAddressLines: ['1 Main St\rSuite 2\f', 'City,\tST 11111'] })
    expect(l.fields[3].lines).toEqual(['1 Main St Suite 2', 'City, ST 11111'])
  })
})

describe('the client’s drawing on the letter', () => {
  const head = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  const withSize = (w: number, h: number, tail = 'x') => { const b = Buffer.alloc(33); Buffer.from(head).copy(b, 0); b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return Buffer.concat([b, Buffer.from(tail)]) }

  it('is on the letter when it is a real PNG', async () => {
    const r = await buildEinClosureLetter({ ...base, signaturePng: PNG_1X1 })
    expect(r).toMatchObject({ signatureUsed: true, warnings: [] })
  })

  it('a picture that cannot be decoded leaves the line to sign by hand and says so — the letter is still made', async () => {
    const r = await buildEinClosureLetter({ ...base, signaturePng: new Uint8Array(withSize(400, 160, 'not really png data')) })
    expect(r.signatureUsed).toBe(false)
    expect(r.warnings.join(' ')).toMatch(/could not be read/)
    expect((await PDFDocument.load(r.bytes)).getPageCount()).toBe(1)
  })

  it('a picture of a huge size is never decoded (it could use up the server)', async () => {
    const r = await buildEinClosureLetter({ ...base, signaturePng: new Uint8Array(withSize(60000, 60000)) })
    expect(r.signatureUsed).toBe(false)
    expect(r.warnings.join(' ')).toMatch(/not a usable size/)
  })

  it('bytes that are not a PNG at all leave the line too', async () => {
    const r = await buildEinClosureLetter({ ...base, signaturePng: Uint8Array.from(Buffer.from('%PDF-1.7 this is not a picture at all')) })
    expect(r.signatureUsed).toBe(false)
  })
})
