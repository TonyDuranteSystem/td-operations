/**
 * Dev job ff2b73d7 — the SS-4 check on a fax (lib/fax/ss4-fax-gate.ts), the helpers it uses, and — the rule Antonio set — WHEN it applies:
 * ONLY to a fax for a client's company (the SS-4 panel, or an SS-4 sent to an IRS EIN fax line). A fax to a third party is never checked
 * and never asks for a company; neither is a non-SS-4 document sent to the IRS.
 *
 * The PDFs below are REAL: built with the project's own SS-4 builder (fillSS4), so the Line 6 reading is proven on what actually goes out.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PDFDocument } from 'pdf-lib'

const fx = vi.hoisted(() => ({
  sd: null as Record<string, unknown> | null,
  account: null as Record<string, unknown> | null,
  ss4: null as Record<string, unknown> | null,
  agent: null as Record<string, unknown> | null,
  storeFile: null as Record<string, unknown> | null,
  storeOwner: null as Record<string, unknown> | null,
  fail: { sd: false, accounts: false, storeFile: false, storeOwner: false },
  queried: [] as string[],
}))

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      fx.queried.push(table)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b: any = {}
      const chain = () => b
      b.select = chain; b.eq = chain; b.in = chain; b.is = chain; b.order = chain; b.limit = chain
      const one = () => {
        if (table === 'service_deliveries') return fx.fail.sd ? { data: null, error: { message: 'boom' } } : { data: fx.sd, error: null }
        if (table === 'accounts') return fx.fail.accounts ? { data: null, error: { message: 'boom' } } : { data: fx.account, error: null }
        if (table === 'ss4_applications') return { data: fx.ss4, error: null }
        if (table === 'addresses') return { data: fx.agent, error: null }
        if (table === 'store_files') return fx.fail.storeFile ? { data: null, error: { message: 'boom' } } : { data: fx.storeFile, error: null }
        if (table === 'store_owners') return fx.fail.storeOwner ? { data: null, error: { message: 'boom' } } : { data: fx.storeOwner, error: null }
        return { data: null, error: null }
      }
      b.maybeSingle = () => Promise.resolve(one())
      b.single = () => Promise.resolve(one())
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(one()).then(res, rej)
      return b
    },
  },
}))

import { checkSs4Fax, CHOOSE_COMPANY_SENTENCE, type Ss4FaxInput } from '@/lib/fax/ss4-fax-gate'
import { isIrsEinFaxNumber, IRS_EIN_FAX_NUMBERS } from '@/lib/fax/irs-ein-numbers'
import { IRS_EIN_FAX_DOMESTIC, DEFAULT_IRS_FAX_NUMBER } from '@/lib/fax/faxage'
import { readSs4PdfFacts, ss4FactsFromText } from '@/lib/fax/ss4-pdf-facts'
import { fillSS4 } from '@/lib/pdf/ss4-fill'

const IRS = '8556416935'
const BANK = '5551234567'
const ACC = 'acc-1'
const NM_ACCOUNT = { company_name: 'Tanto per LLC', state_of_formation: 'New Mexico', registered_agent_id: 'ra-1' }

async function ss4Pdf(line6: string): Promise<Buffer> {
  const bytes = await fillSS4({
    companyName: 'Tanto per LLC', entityType: 'SMLLC', stateOfFormation: 'NM', formationDate: '2026-10-20', memberCount: 1,
    responsiblePartyName: 'Alessandro Girino', responsiblePartyTitle: 'Owner',
    mailingStreet: '10225 Ulmerton Rd 3D', mailingCityStateZip: 'Largo, FL 33771', countyAndState: line6,
  } as never)
  return Buffer.from(bytes)
}
/** The IRS package: the SS-4 first, then other pages (as ss4-signed builds it). */
async function packagePdf(line6: string): Promise<Buffer> {
  const ss4 = await PDFDocument.load(await ss4Pdf(line6))
  const merged = await PDFDocument.create()
  const [p] = await merged.copyPages(ss4, [0])
  merged.addPage(p)
  const articles = merged.addPage()
  articles.drawText('Articles of Organization — Bernalillo County, New Mexico', { x: 40, y: 700, size: 12 })
  return Buffer.from(await merged.save())
}
const plainPdf = async (text: string) => {
  const d = await PDFDocument.create()
  d.addPage().drawText(text, { x: 40, y: 700, size: 12 })
  return Buffer.from(await d.save())
}

const input = (o: Partial<Ss4FaxInput>): Ss4FaxInput => ({
  faxno: IRS, panelServiceDeliveryId: null, fileName: 'Form SS-4 - Tanto per LLC - For IRS.pdf', bytes: Buffer.from('hello'),
  documentRow: null, storeFileId: null, chosenCompanyAccountId: null, ...o,
})

beforeEach(() => {
  fx.sd = { account_id: ACC }
  fx.account = { ...NM_ACCOUNT }
  fx.ss4 = { county_and_state: 'Bernalillo County, New Mexico' }
  fx.agent = { state: 'NM', county: 'Bernalillo' }
  fx.storeFile = { owner_id: 'owner-1' }
  fx.storeOwner = { kind: 'company', account_id: ACC }
  fx.fail = { sd: false, accounts: false, storeFile: false, storeOwner: false }
  fx.queried = []
})

describe('the IRS EIN fax lines', () => {
  it('recognises both lines however they are typed', () => {
    for (const n of ['8556416935', '855-641-6935', '(855) 641-6935', '+1 855 641 6935', '18556416935', '8552151627', '1-855-215-1627']) expect(isIrsEinFaxNumber(n)).toBe(true)
  })
  it('never matches a third party', () => {
    for (const n of ['5551234567', '', '855641693', '8556416936', null, undefined]) expect(isIrsEinFaxNumber(n as never)).toBe(false)
  })
  it('stays pinned to the constants the fax library sends with (they can never drift apart)', () => {
    expect(IRS_EIN_FAX_NUMBERS).toContain(IRS_EIN_FAX_DOMESTIC)
    expect(IRS_EIN_FAX_NUMBERS).toContain(DEFAULT_IRS_FAX_NUMBER)
  })
})

describe('reading an SS-4 PDF (real files from the project\'s own builder)', () => {
  it('reads Line 6 off the signed form', async () => {
    const f = await readSs4PdfFacts(await ss4Pdf('Sheridan County, Wyoming'))
    expect(f.isSs4).toBe(true)
    expect(f.line6State).toBe('WY')
    expect(f.line6Text).toBe('Sheridan County, Wyoming')
    expect((await readSs4PdfFacts(await ss4Pdf('Bernalillo County, New Mexico'))).line6State).toBe('NM')
    expect((await readSs4PdfFacts(await ss4Pdf('Pinellas County, Florida'))).line6State).toBe('FL')
  })
  it('reads page 1 of the IRS package (SS-4 first) and ignores the Articles pages behind it', async () => {
    const f = await readSs4PdfFacts(await packagePdf('Sheridan County, Wyoming'))
    expect(f.isSs4).toBe(true)
    expect(f.line6State).toBe('WY')
  })
  it('a PDF that is not an SS-4 is not an SS-4, and bytes that are not a PDF are never read', async () => {
    expect((await readSs4PdfFacts(await plainPdf('Letter to the IRS about Bernalillo County, New Mexico'))).isSs4).toBe(false)
    expect((await readSs4PdfFacts(Buffer.from('hello'))).isSs4).toBe(false)
    expect((await readSs4PdfFacts(Buffer.from('%PDF-1.4 garbage that is not a pdf'))).isSs4).toBe(false)
    expect((await readSs4PdfFacts(Buffer.alloc(0))).isSs4).toBe(false)
  })
  it('the text rule: an SS-4 title with no readable Line 6 is an SS-4 with an UNKNOWN state, never a guess', () => {
    expect(ss4FactsFromText('Application for Employer Identification Number\n6 County and state where principal business is located\n')).toMatchObject({ isSs4: true, line6State: null })
    expect(ss4FactsFromText('Application for Employer Identification Number\nSheridan County, Wyoming 7a Name of responsible party')).toMatchObject({ line6State: 'WY' })
    expect(ss4FactsFromText('Application for Employer Identification Number\nBernalillo County, New Mexico\n7a Name')).toMatchObject({ line6State: 'NM' })
    expect(ss4FactsFromText('nothing relevant').isSs4).toBe(false)
  })
})

describe('checkSs4Fax — WHEN it applies (Antonio: only a fax for a client\'s company)', () => {
  it('A FAX TO A THIRD PARTY IS NEVER CHECKED — not even an SS-4 of a company whose agent is in the wrong state — and nothing is looked up', async () => {
    fx.agent = { state: 'WY', county: 'Sheridan' }
    fx.ss4 = { county_and_state: 'Sheridan County, Wyoming' }
    const r = await checkSs4Fax(input({ faxno: BANK, bytes: await ss4Pdf('Sheridan County, Wyoming'), documentRow: { account_id: ACC, document_type_name: 'Form SS-4 (Signed)' } }))
    expect(r.ok).toBe(true)
    expect(fx.queried).toEqual([]) // no company lookup, no prompt, nothing
  })

  it('a third party never gets the "choose the company" question either', async () => {
    const r = await checkSs4Fax(input({ faxno: BANK, fileName: 'SS-4 copy.pdf' }))
    expect(r.ok).toBe(true)
    expect(fx.queried).toEqual([])
  })

  it('a document that is not an SS-4 sent to the IRS is not checked and asks for nothing', async () => {
    const r = await checkSs4Fax(input({ fileName: 'Letter to IRS.pdf', bytes: await plainPdf('Please confirm our EIN') }))
    expect(r.ok).toBe(true)
    expect(fx.queried).toEqual([])
  })

  it('an SS-4 sent to the IRS EIN line IS checked', async () => {
    fx.agent = { state: 'WY', county: 'Sheridan' }
    const r = await checkSs4Fax(input({ chosenCompanyAccountId: ACC }))
    expect(r.ok).toBe(false)
    expect(r.status).toBe(409)
    expect(r.error).toContain('in Wyoming')
  })

  it('the SS-4 panel is checked whatever number it carries (it is the company\'s own SS-4 flow)', async () => {
    fx.agent = { state: 'WY', county: 'Sheridan' }
    const r = await checkSs4Fax(input({ faxno: BANK, panelServiceDeliveryId: 'sd-1' }))
    expect(r.ok).toBe(false)
    expect(r.error).toContain('in Wyoming')
  })
})

describe('checkSs4Fax — tying the fax to the client\'s company', () => {
  it('an SS-4 to the IRS with NO company is refused with the "choose the company" sentence (an upload with "don\'t save")', async () => {
    const r = await checkSs4Fax(input({}))
    expect(r.ok).toBe(false)
    expect(r.status).toBe(409)
    expect(r.error).toBe(CHOOSE_COMPANY_SENTENCE)
    expect(r.error).toContain('Nothing was faxed')
  })

  it('an SS-4 recognised only by its CONTENT (a file renamed "scan.pdf") still needs a company', async () => {
    const r = await checkSs4Fax(input({ fileName: 'scan.pdf', bytes: await ss4Pdf('Bernalillo County, New Mexico') }))
    expect(r.ok).toBe(false)
    expect(r.error).toBe(CHOOSE_COMPANY_SENTENCE)
  })

  it('the company comes from: the panel\'s case, the stored document, the storage file\'s company, or the company staff chose', async () => {
    expect((await checkSs4Fax(input({ panelServiceDeliveryId: 'sd-1' }))).ok).toBe(true)
    expect((await checkSs4Fax(input({ documentRow: { account_id: ACC, document_type_name: 'Form SS-4 (Signed)' } }))).ok).toBe(true)
    expect((await checkSs4Fax(input({ storeFileId: '11111111-1111-4111-8111-111111111111' }))).ok).toBe(true)
    expect((await checkSs4Fax(input({ chosenCompanyAccountId: ACC }))).ok).toBe(true)
  })

  it('a storage file that is NOT in a company (a personal folder) does not count as a company', async () => {
    fx.storeOwner = { kind: 'person', account_id: null }
    const r = await checkSs4Fax(input({ storeFileId: '11111111-1111-4111-8111-111111111111' }))
    expect(r.ok).toBe(false)
    expect(r.error).toBe(CHOOSE_COMPANY_SENTENCE)
  })

  it('a storage file id that is not an id is ignored, never queried', async () => {
    const r = await checkSs4Fax(input({ storeFileId: "x'; drop table accounts;--" }))
    expect(r.ok).toBe(false)
    expect(fx.queried).not.toContain('store_files')
  })
})

describe('checkSs4Fax — the company records and the file itself', () => {
  it('Share → Fax of the Tanto per file, company in the wrong state → refused with the plain reason', async () => {
    fx.agent = { state: 'WY', county: 'Sheridan' }
    fx.ss4 = { county_and_state: 'Sheridan County, Wyoming' }
    const r = await checkSs4Fax(input({ storeFileId: '11111111-1111-4111-8111-111111111111', bytes: await ss4Pdf('Sheridan County, Wyoming') }))
    expect(r.ok).toBe(false)
    expect(r.error).toContain('The registered agent for Tanto per LLC is in Wyoming')
    expect(r.error).toContain('Nothing was faxed')
  })

  it('THE STALE-FILE CASE: the records are now right but the FILE still prints Wyoming → refused, and it says what to do', async () => {
    const r = await checkSs4Fax(input({ chosenCompanyAccountId: ACC, bytes: await packagePdf('Sheridan County, Wyoming') }))
    expect(r.ok).toBe(false)
    expect(r.status).toBe(409)
    expect(r.error).toContain('shows Wyoming on Line 6')
    expect(r.error).toContain('"Sheridan County, Wyoming"')
    expect(r.error).toContain('formed in New Mexico')
    expect(r.error).toContain('SS-4 panel')
  })

  it('records right AND the file right → goes ahead', async () => {
    expect((await checkSs4Fax(input({ chosenCompanyAccountId: ACC, bytes: await packagePdf('Bernalillo County, New Mexico') }))).ok).toBe(true)
  })

  it('an SS-4 file whose text cannot be read falls back to the records (it is never a dead end)', async () => {
    expect((await checkSs4Fax(input({ chosenCompanyAccountId: ACC, bytes: Buffer.from('%PDF-1.4 scan') }))).ok).toBe(true)
  })

  it('a stale saved Line 6 on the record is refused even when the file is fine', async () => {
    fx.ss4 = { county_and_state: 'Sheridan County, Wyoming' }
    const r = await checkSs4Fax(input({ chosenCompanyAccountId: ACC, bytes: await packagePdf('Bernalillo County, New Mexico') }))
    expect(r.ok).toBe(false)
    expect(r.error).toContain('Line 6 of this SS-4 says Wyoming')
  })

  it('FAILS CLOSED: a record that cannot be read refuses the fax (503, "NOT sent")', async () => {
    fx.fail.sd = true
    const a = await checkSs4Fax(input({ panelServiceDeliveryId: 'sd-1' }))
    expect(a.ok).toBe(false)
    expect(a.status).toBe(503)
    expect(a.error).toContain('NOT sent')
    fx.fail = { sd: false, accounts: true, storeFile: false, storeOwner: false }
    expect((await checkSs4Fax(input({ chosenCompanyAccountId: ACC }))).status).toBe(503)
    fx.fail = { sd: false, accounts: false, storeFile: true, storeOwner: false }
    expect((await checkSs4Fax(input({ storeFileId: '11111111-1111-4111-8111-111111111111' }))).status).toBe(503)
    fx.fail = { sd: false, accounts: false, storeFile: false, storeOwner: true }
    expect((await checkSs4Fax(input({ storeFileId: '11111111-1111-4111-8111-111111111111' }))).status).toBe(503)
  })
})
