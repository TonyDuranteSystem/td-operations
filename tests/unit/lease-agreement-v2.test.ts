import { describe, it, expect } from 'vitest'
import { buildAgreementV2, newYorkToday, addMonthsIso, longDate, agreementAddresses, AGREEMENT_V2_TITLE } from '@/lib/lease/agreement-v2'
import { generateLeasePDF, printable } from '@/lib/lease-pdf'
import { toPublicLease, LEASE_SELECT } from '@/lib/lease/public-view'

const INPUT = {
  agreementNo: 'acme-llc-2026',
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
    expect(allText(buildAgreementV2(INPUT))).not.toContain('Exhibit A')
    const withPhotos = buildAgreementV2({ ...INPUT, exhibitPhotos: [{ url: 'https://x/y.jpg', caption: 'Lobby' }] })
    expect(allText(withPhotos)).toContain('Exhibit A')
    expect(withPhotos.exhibitPhotos).toHaveLength(1)
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
    const v2 = await pdfText(await generateLeasePDF({ ...common, templateVersion: 2, agreementNo: 'acme-llc-2026', operatingAddress: 'Via Roma 1, Milano, Italy', signedDate: '2026-10-10' }))
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
