import { describe, it, expect } from 'vitest'
import { buildAgreementV2, newYorkToday, addMonthsIso, endOfYearIso, termMonthsThroughYearEnd, longDate, agreementAddresses, AGREEMENT_V2_TITLE } from '@/lib/lease/agreement-v2'
import { generateLeasePDF, printable } from '@/lib/lease-pdf'
import { toPublicLease, LEASE_SELECT } from '@/lib/lease/public-view'

const INPUT = {
  providerName: 'Tony Durante LLC',
  clientCompany: 'Acme LLC',
  clientState: 'Wyoming',
  clientEin: '12-3456789',
  clientRepName: 'Jane Rossi',
  clientRepTitle: 'Manager',
  suiteNumber: '3D-318',
  operatingAddress: null as string | null,
}
/** The text of a PDF, extracted the way a reader would (handles the embedded Unicode font too). */
async function pdfText(bytes: Uint8Array): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const parse = require('pdf-parse/lib/pdf-parse.js') as (b: Buffer) => Promise<{ text: string }>
  return (await parse(Buffer.from(bytes))).text
}
const allText = (doc: ReturnType<typeof buildAgreementV2>) =>
  doc.blocks.map(b => ('text' in b ? b.text : 'lines' in b ? b.lines.join(' ') : '')).join('\n')

describe('Office Lease and Services Agreement (template v2) — the one shared text', () => {
  it('prints the official address and the mailing address (official + the company\'s own PMB) exactly', () => {
    const a = agreementAddresses('3D-318')
    expect(a.official).toEqual(['10225 Ulmerton Rd 3D', 'Largo, FL 33771'])
    expect(a.mailing).toEqual(['10225 Ulmerton Rd 3D PMB 318', 'Largo, FL 33771'])
    const doc = buildAgreementV2(INPUT)
    const addrBlocks = doc.blocks.filter(b => b.t === 'address') as { lines: string[] }[]
    expect(addrBlocks).toHaveLength(2)
    expect(addrBlocks[0].lines).toEqual(['Acme LLC', '10225 Ulmerton Rd 3D', 'Largo, FL 33771'])
    expect(addrBlocks[1].lines).toEqual(['Acme LLC', '10225 Ulmerton Rd 3D PMB 318', 'Largo, FL 33771'])
  })

  it('a different company gets a different PMB but the same official address', () => {
    const d = buildAgreementV2({ ...INPUT, suiteNumber: '3D-205' })
    expect(allText(d)).toContain('10225 Ulmerton Rd 3D PMB 205')
    expect(allText(d)).not.toContain('PMB 318')
  })

  it('the parties line reads correctly: a/an by sound, corporation vs limited liability company', () => {
    const line = (o: Partial<typeof INPUT>) => allText(buildAgreementV2({ ...INPUT, ...o }))
    expect(line({ clientState: 'Wyoming' })).toContain('a Wyoming limited liability company')
    expect(line({ clientState: 'Illinois' })).toContain('an Illinois limited liability company')
    expect(line({ clientState: 'Ohio' })).toContain('an Ohio limited liability company')
    expect(line({ clientState: 'Delaware', clientCompany: 'Atlas Compliance INC' })).toContain('a Delaware corporation')
    expect(line({ clientState: null })).toContain('a limited liability company')
  })

  it('a company without a numbered suite cannot get this agreement (no PMB to print)', () => {
    expect(() => buildAgreementV2({ ...INPUT, suiteNumber: 'TBD' })).toThrow('not a numbered TD suite')
  })

  it('has the title and none of the old lease language: no rent, deposit, late fees or auto-renewal', () => {
    const t = allText(buildAgreementV2(INPUT))
    expect(AGREEMENT_V2_TITLE).toBe('OFFICE LEASE AND SERVICES AGREEMENT')
    expect(t).toContain('No separate rent and no security deposit are payable')
    expect(t).toContain('does not renew automatically')
    expect(t).not.toMatch(/Monthly Rent|Security Deposit|late fee|Landlord|Tenant/)
    expect(t).not.toContain('Suite 3D-318')
  })

  it('never mentions the building owner or says "virtual office"', () => {
    const t = allText(buildAgreementV2(INPUT)).toLowerCase()
    expect(t).not.toContain('jag')
    expect(t).not.toContain('virtual office')
  })

  it('the Operating Address is a placeholder until the client types it, then appears in Section 1.1', () => {
    expect(allText(buildAgreementV2(INPUT))).toContain('the address Client enters when signing')
    const t = allText(buildAgreementV2({ ...INPUT, operatingAddress: 'Via Roma 1, Milano, Italy' }))
    expect(t).toContain('run from Via Roma 1, Milano, Italy (the "Operating Address")')
  })

  it('Exhibit A is only mentioned when photos exist', () => {
    expect(allText(buildAgreementV2({ ...INPUT, exhibitPhotos: [] }))).not.toContain('Exhibit A')
    const withPhotos = buildAgreementV2({ ...INPUT, exhibitPhotos: [{ url: 'https://x/y.jpg', caption: 'Lobby' }] })
    expect(allText(withPhotos)).toContain('Exhibit A')
    expect(withPhotos.exhibitPhotos).toHaveLength(1)
  })

  it('Exhibit A carries the ten premises photos Antonio chose; the files exist; the staged ones say "illustrative"', async () => {
    const doc = buildAgreementV2(INPUT)
    expect(doc.exhibitPhotos).toHaveLength(10)
    expect(allText(doc)).toContain('including the office areas shown in Exhibit A')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs')
    for (const p of doc.exhibitPhotos) {
      const file = `${process.cwd()}/public${p.url}`
      expect(fs.existsSync(file), file).toBe(true)
      expect(fs.readFileSync(file).subarray(0, 2).toString('hex')).toBe('ffd8') // a JPEG
      expect(p.caption.length).toBeGreaterThan(5)
    }
    expect(doc.exhibitPhotos.filter(p => /illustrative/i.test(p.caption))).toHaveLength(4)
    expect(doc.exhibitPhotos.slice(0, 6).some(p => /illustrative/i.test(p.caption))).toBe(false)
  })

  it('the server PDF prints Exhibit A (the photos, two per page) after the signature block, and nothing when there are none', async () => {
    const base = { tenantCompany: 'Acme LLC', tenantContactName: 'Jane Rossi', suiteNumber: '3D-318', effectiveDate: '2026-10-12', termStartDate: '2026-10-12', termEndDate: '2026-12-31', signedDate: '2026-10-12', templateVersion: 2 }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const parse = require('pdf-parse/lib/pdf-parse.js') as (b: Buffer) => Promise<{ text: string; numpages: number }>
    const withEx = await parse(Buffer.from(await generateLeasePDF(base)))
    expect(withEx.text).toContain('EXHIBIT A')
    expect(withEx.text).toContain('The Sugar Creek Professional Office Center sign')
    expect(withEx.numpages).toBeGreaterThanOrEqual(8) // 4 pages of agreement + 5 of photos
    const raw = Buffer.from(await generateLeasePDF(base)).toString('latin1')
    expect((raw.match(/\/DCTDecode/g) ?? []).length).toBeGreaterThanOrEqual(11) // the logo + ten photos
    const without = await parse(Buffer.from(await generateLeasePDF({ ...base, exhibitPhotos: [] })))
    expect(without.text).not.toContain('EXHIBIT A')
    expect(without.numpages).toBe(4)
  })

  it('prints no client email (the browser never receives it) — only Provider\'s own notice address', () => {
    expect(allText(buildAgreementV2(INPUT)).match(/[\w.+-]+@[\w.-]+/g)).toEqual(['support@tonydurante.us'])
  })
})

describe('server-issued dates', () => {
  it('newYorkToday uses New York time, not UTC', () => {
    // 2026-10-11 02:30 UTC is still 2026-10-10 22:30 in New York
    expect(newYorkToday(new Date('2026-10-11T02:30:00Z'))).toBe('2026-10-10')
    expect(newYorkToday(new Date('2026-10-11T05:00:00Z'))).toBe('2026-10-11')
  })
  it('the term runs from the last signature to December 31 of that year, and the January renewal is explained', () => {
    const t = allText(buildAgreementV2(INPUT))
    expect(t).toContain('ends on December 31 of the year in which the Effective Date falls')
    expect(t).not.toContain('twelve (12) months after the Effective Date')
    expect(t).toContain('Provider will issue a new agreement each January for that calendar year')
    expect(t).toContain('Until the new agreement is signed, Provider continues to provide the same services and to handle Client\'s mail on the same terms')
    // the address / remailing duties start only when the agreement ends WITHOUT a replacement — a yearly expiry is not an exit
    expect(t).toContain('When this Agreement ends and is not replaced by a new agreement, Client will stop using')
    expect(t).toContain('after this Agreement ends and is not replaced by a new agreement')
  })

  it('there is no "Agreement No." line (page text and PDF), and the server PDF carries the logo banner at the top', async () => {
    expect(allText(buildAgreementV2(INPUT))).not.toMatch(/Agreement No/i)
    const bytes = await generateLeasePDF({ tenantCompany: 'Acme LLC', tenantContactName: 'Jane Rossi', suiteNumber: '3D-318', effectiveDate: '2026-10-12', termStartDate: '2026-10-12', termEndDate: '2026-12-31', templateVersion: 2 })
    expect(await pdfText(bytes)).not.toMatch(/Agreement No/i)
    // the banner is a JPEG image on page 1 (pdf-lib writes it as a DCTDecode image XObject)
    const raw = Buffer.from(bytes).toString('latin1')
    expect(raw).toContain('/DCTDecode')
  })

  it('a normal agreement is four pages and the signature block shares the last page with the final clauses', async () => {
    const bytes = await generateLeasePDF({ tenantCompany: 'Example Holdings LLC', tenantContactName: 'Maria Rossi', tenantTitle: 'Manager', tenantState: 'Wyoming', tenantEin: '12-3456789', suiteNumber: '3D-318', effectiveDate: '2026-10-12', termStartDate: '2026-10-12', termEndDate: '2026-12-31', signedDate: '2026-10-12', templateVersion: 2, operatingAddress: 'Via Roma 1, 20121 Milano, Italy', exhibitPhotos: [] })
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const parse = require('pdf-parse/lib/pdf-parse.js') as (b: Buffer) => Promise<{ text: string; numpages: number }>
    const out = await parse(Buffer.from(bytes))
    expect(out.numpages).toBe(4)
    expect(out.text).toContain('Page 4 of 4')
    // the last page holds both a numbered clause and the signature block
    const lastPage = out.text.slice(out.text.indexOf('Page 3 of 4'))
    expect(lastPage).toContain('9.10')
    expect(lastPage).toContain('IN WITNESS WHEREOF')
  })

  it('endOfYearIso / termMonthsThroughYearEnd', () => {
    expect(endOfYearIso('2026-10-12')).toBe('2026-12-31')
    expect(endOfYearIso('2027-01-01')).toBe('2027-12-31')
    expect(endOfYearIso('2026-12-31')).toBe('2026-12-31')
    expect(termMonthsThroughYearEnd('2026-10-12')).toBe(3)
    expect(termMonthsThroughYearEnd('2027-01-01')).toBe(12)
    expect(termMonthsThroughYearEnd('2026-12-31')).toBe(1)
  })

  it('addMonthsIso adds a calendar year without drifting (and clamps Feb 29)', () => {
    expect(addMonthsIso('2026-10-10', 12)).toBe('2027-10-10')
    expect(addMonthsIso('2028-02-29', 12)).toBe('2029-02-28')
    expect(addMonthsIso('2026-01-31', 1)).toBe('2026-02-28')
  })
  it('longDate has no timezone shift', () => {
    expect(longDate('2026-10-10')).toBe('October 10, 2026')
  })
})

describe('public lease payload and the server PDF', () => {
  it('the public lease carries template_version and operating_address; the browser still never gets the email or code', () => {
    expect(LEASE_SELECT).toContain('template_version')
    expect(LEASE_SELECT).toContain('operating_address')
    const pub = toPublicLease({ id: '1', token: 't', template_version: 2, operating_address: 'X', tenant_email: 'a@b.c', access_code: 'zz' })
    expect(pub.template_version).toBe(2)
    expect(JSON.stringify(pub)).not.toContain('a@b.c')
    expect(toPublicLease({ id: '1', token: 't' }).template_version).toBe(1)
  })

  it('the v2 PDF carries the new agreement text and addresses; the v1 PDF still carries the original text (frozen)', async () => {
    const common = { tenantCompany: 'Acme LLC', tenantContactName: 'Jane Rossi', tenantTitle: 'Manager', suiteNumber: '3D-318', effectiveDate: '2026-10-10', termStartDate: '2026-10-10', termEndDate: '2027-10-10' }
    const v2 = await pdfText(await generateLeasePDF({ ...common, templateVersion: 2, operatingAddress: 'Via Roma 1, Milano, Italy', signedDate: '2026-10-10' }))
    expect(v2).toContain('OFFICE LEASE AND SERVICES AGREEMENT')
    expect(v2).toContain('10225 Ulmerton Rd 3D PMB 318')
    expect(v2).toContain('Via Roma 1, Milano, Italy')
    expect(v2).toContain('October 10, 2026')
    expect(v2).not.toContain('Monthly Rent')
    const v1 = await pdfText(await generateLeasePDF(common))
    expect(v1).toContain('OFFICE LEASE AGREEMENT')
    expect(v1).toContain('Suite 3D-318')
    expect(v1).toContain('Monthly Rent')
    expect(v1).not.toContain('SERVICES AGREEMENT')
  })

  it('a very long company and signer name stay on the page in the signature block (wrapped / shrunk, nothing cut off)', async () => {
    const bytes = await generateLeasePDF({
      tenantCompany: 'Mediterranean Ventures Holdings International Group LLC', tenantContactName: 'Maria Fernanda Rodriguez de la Cruz y Montenegro', suiteNumber: '3D-318',
      effectiveDate: '2026-10-10', termStartDate: '2026-10-10', termEndDate: '2027-10-10', templateVersion: 2, signedDate: '2026-10-10',
    })
    const text = await pdfText(bytes)
    expect(text).toContain('Mediterranean Ventures Holdings')
    expect(text).toContain('Group LLC')
    expect(text).toContain('Maria Fernanda Rodriguez de la Cruz y Montenegro')
  })

  it('names and a non-Latin Operating Address print as typed in the server PDF (accents, Cyrillic), never "?"-mangled; emoji become "?"', async () => {
    expect(printable('București 🙂\nx')).toBe('București ? x')
    const bytes = await generateLeasePDF({
      tenantCompany: 'Società Niccolò Città LLC', tenantContactName: 'Józef Łukasz', suiteNumber: '3D-318', effectiveDate: '2026-10-10', termStartDate: '2026-10-10', termEndDate: '2027-10-10',
      templateVersion: 2, operatingAddress: 'Str. Eminescu 5, București, Москва ' + 'x'.repeat(300),
    })
    const text = await pdfText(bytes)
    expect(text).toContain('Società Niccolò Città LLC')
    expect(text).toContain('Józef Łukasz')
    expect(text).toContain('București')
    expect(text).toContain('Москва')
    // an unbroken 300-character string is wrapped onto several lines, not left to run off the page
    expect(text.split('\n').some(l => l.length > 150)).toBe(false)
  })
})
