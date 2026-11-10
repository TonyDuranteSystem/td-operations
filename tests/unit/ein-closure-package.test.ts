import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PDFDocument } from 'pdf-lib'

// ── a tiny fake of the database: every table answers with the rows the test put there; the filters asked are recorded ──
const tables: Record<string, Array<Record<string, unknown>>> = {}
const asked: Array<{ table: string; filters: Array<[string, unknown]> }> = []
function builder(table: string) {
  const rec = { table, filters: [] as Array<[string, unknown]>, others: false }
  asked.push(rec)
  const chain: Record<string, unknown> = {}
  const self = () => chain
  Object.assign(chain, {
    select: self,
    in: self,
    is: self,
    neq: () => { rec.others = true; return chain }, // "the OTHER open closures of this scope": none in these tests
    order: self,
    limit: self,
    eq: (c: string, v: unknown) => { rec.filters.push([c, v]); return chain },
    maybeSingle: async () => ({ data: (tables[table] ?? [])[0] ?? null, error: null }),
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve({ data: rec.others ? [] : tables[table] ?? [], error: null }).then(res, rej),
  })
  return chain
}
vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: { from: (t: string) => builder(t) } }))

let hasSuite = false
vi.mock('@/lib/operations/suite', () => ({ companyCmraAddressLine: vi.fn(async () => (hasSuite ? '10225 Ulmerton Rd 3D, Largo, FL 33771' : null)) }))

const saveAccount = vi.fn()
const saveContact = vi.fn()
class FakeMoving extends Error {}
vi.mock('@/lib/crm-store/save-for-account', () => ({ saveDocumentForAccount: (...a: unknown[]) => saveAccount(...a), saveDocumentForContact: (...a: unknown[]) => saveContact(...a), CompanyMovingError: FakeMoving }))
vi.mock('@/lib/crm-store/formation-pilot', () => ({ ensurePersonOwner: vi.fn(async () => 'owner-1') }))
vi.mock('@/lib/crm-store/switched-drive-guard', () => ({ liveOwnerOfContact: vi.fn(async () => 'owner-1') }))

let noticeBytes: Buffer = Buffer.alloc(0)
let sigBytes: Buffer = Buffer.alloc(0)
const SIG_STORE_ID = '55555555-5555-4555-8555-555555555555'
vi.mock('@/lib/crm-store/document-pointer', async (orig) => {
  const actual = await orig<typeof import('@/lib/crm-store/document-pointer')>()
  return {
    ...actual,
    readStoreFile: vi.fn(async (id: string) =>
      id === '55555555-5555-4555-8555-555555555555'
        ? { bytes: sigBytes, mimeType: 'image/png', name: 'signature_image_signature.png' }
        : { bytes: noticeBytes, mimeType: 'application/pdf', name: 'ein_letter_Italyflow_LLC_CP_575_B.pdf' },
    ),
  }
})

import { buildEinClosureLetterPdf } from '@/lib/closure/ein-closure-letter'
import {
  buildEinClosurePackage,
  loadEinClosureFacts,
  isEinNoticeCandidate,
  einNoticeMatch,
  splitAddress,
  addressToLines,
  signerFromAnswers,
  einPackageName,
  einPackageCallerKey,
  EIN_PACKAGE_DOC_TYPE,
} from '@/lib/closure/ein-closure-package'

const JOB = 'a8cd7976-8125-4afa-a92b-1939cc2609b7'
const answers = {
  llc_name: 'Italyflow LLC', llc_ein: '41-2330246', llc_state: 'New Mexico', owner_first_name: 'Christian', owner_last_name: 'Ranieri',
  first_name: 'Christian', last_name: 'Ranieri', tax_returns_filed: 'Yes', ein_letter: 'closure/x/ein_letter_Italyflow_LLC_CP_575_B.pdf',
}
const jobRow = (over: Record<string, unknown> = {}) => ({ id: JOB, service_type: 'Company Closure', stage: 'IRS Closure', status: 'active', account_id: null, contact_id: 'c-1', created_at: '2026-10-23T22:00:00Z', source_closure_token: null, ...over })
const docs = [
  { id: 'd-summary', file_name: 'Closure_Data_Italyflow_LLC.pdf', document_type_name: 'Other document', drive_file_id: 'store:11111111-1111-4111-8111-111111111111', created_at: '2026-11-10T15:22:00Z' },
  { id: 'd-ein', file_name: 'ein_letter_Italyflow_LLC_CP_575_B.pdf', document_type_name: 'EIN CP575B', drive_file_id: 'store:22222222-2222-4222-8222-222222222222', created_at: '2026-11-10T15:22:01Z' },
  { id: 'd-articles', file_name: 'Articles_of_Organization__Italyflow_LLC.pdf', document_type_name: 'Articles of Organization', drive_file_id: 'store:33333333-3333-4333-8333-333333333333', created_at: '2026-11-10T15:22:02Z' },
]

function seed(over: { job?: Record<string, unknown>; submitted?: Record<string, unknown> | null; docRows?: typeof docs; account?: Record<string, unknown> | null; trashed?: string[] } = {}) {
  for (const k of Object.keys(tables)) delete tables[k]
  asked.length = 0
  tables.service_deliveries = [jobRow(over.job)]
  tables.closure_submissions = over.submitted === null ? [] : [{ token: 't', status: 'completed', created_at: '2026-10-23T23:28:00Z', completed_at: null, submitted_data: over.submitted ?? answers }]
  tables.documents = over.docRows ?? docs
  tables.accounts = over.account ? [over.account] : []
  tables.contacts = [{ full_name: 'Christian Ranieri' }]
  // every stored file the documents point at is LIVE unless the test says it was trashed
  tables.store_files = (tables.documents as Array<{ drive_file_id?: string | null }>)
    .map((d) => (typeof d.drive_file_id === 'string' && d.drive_file_id.startsWith('store:') ? d.drive_file_id.slice(6) : null))
    .filter((id): id is string => !!id)
    .map((id) => ({ id, state: (over.trashed ?? []).includes(id) ? 'trashed' : 'live' }))
}

beforeEach(async () => {
  hasSuite = false
  saveAccount.mockReset()
  saveContact.mockReset()
  const sample = await buildEinClosureLetterPdf({ companyName: 'X LLC', ein: '12-3456789', companyAddressLines: ['1 Main St'], signerName: 'A B', date: new Date(), includesEinNotice: false })
  noticeBytes = Buffer.from(sample)
  sigBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
})

describe('pure helpers', () => {
  it('recognises the company EIN notice and nothing else', () => {
    expect(isEinNoticeCandidate('ein_letter_Italyflow_LLC_CP_575_B.pdf', 'EIN CP575B')).toBe(true)
    expect(isEinNoticeCandidate('EIN Confirmation Letter IRS - Closify Consulting LLC - 2025.pdf', 'EIN IRS FAX - LTR 147C')).toBe(true)
    expect(isEinNoticeCandidate('scan.pdf', 'EIN Letter (IRS)')).toBe(true)
    expect(isEinNoticeCandidate('CP 575 copy.pdf', null)).toBe(true)
    expect(isEinNoticeCandidate('EIN Closure Letter - Italyflow LLC.pdf', 'EIN Cancellation Request')).toBe(false) // our own package
    expect(isEinNoticeCandidate('IRS EIN Cancellation Letter - Cristina Isac LLC - 2025.pdf', 'EIN Cancellation Receipt from IRS')).toBe(false) // the IRS's answer
    expect(isEinNoticeCandidate('Cancel-EIN-IRS-Close-Account-Letter - Italyflow LLC.pdf', 'EIN Cancellation Request')).toBe(false)
    expect(isEinNoticeCandidate('Articles_of_Organization__Italyflow_LLC.pdf', 'Articles of Organization')).toBe(false)
    expect(isEinNoticeCandidate('Closure_Data_Italyflow_LLC.pdf', 'Other document')).toBe(false)
  })

  it('matches the words as whole words: a typed EIN letter is never lost to its file name, a name-only match is a guess', () => {
    expect(einNoticeMatch('EIN_enclosure_scan.pdf', 'EIN Letter (IRS)')).toBe('type') // typed: the name does not matter
    expect(einNoticeMatch('disclosure CP 575.pdf', null)).toBe('name') // "disclosure" is not "closure"
    expect(einNoticeMatch('ein_letter_disclosure.pdf', null)).toBe('name')
    expect(einNoticeMatch('EIN closure request.pdf', null)).toBeNull() // a standalone "closure"
    expect(einNoticeMatch('scan CP575B.pdf', null)).toBe('name')
    expect(einNoticeMatch('ACP5750.pdf', null)).toBeNull() // no word boundary: not an IRS form number
    expect(einNoticeMatch('notes 147C extra.pdf', null)).toBe('name')
    expect(einNoticeMatch('x1147Cx.pdf', null)).toBeNull()
  })

  it('keeps every line a person types — nothing is cut here (a letter that cannot hold it says so)', () => {
    expect(splitAddress('  1209 Mountain Road PL NE Ste R \r\n\nAlbuquerque, NM 87110  ')).toEqual(['1209 Mountain Road PL NE Ste R', 'Albuquerque, NM 87110'])
    expect(splitAddress('a\nb\nc\nd\ne\nf\ng')).toHaveLength(7)
    expect(splitAddress('x'.repeat(200))[0]).toHaveLength(200)
    expect(splitAddress('a  b \t c')).toEqual(['a b c'])
    expect(splitAddress('  \n ')).toEqual([])
  })

  it('turns the address on file into letter lines without dropping a piece', () => {
    expect(addressToLines('1209 Mountain Road PL NE Ste R, Albuquerque, NM 87110')).toEqual(['1209 Mountain Road PL NE Ste R', 'Albuquerque, NM 87110'])
    expect(addressToLines('c/o Agent Inc., 1209 Mountain Road, Ste R, Albuquerque, NM 87110-1234')).toEqual(['c/o Agent Inc., 1209 Mountain Road, Ste R', 'Albuquerque, NM 87110-1234'])
    expect(addressToLines('Via Roma 1\n00100 Roma\nItaly\nExtra\nFive')).toHaveLength(5) // a multi-line address is kept as typed
    expect(addressToLines('Strada 1, Roma, Italia')).toEqual(['Strada 1', 'Roma', 'Italia']) // not a US address: pieces kept
    expect(addressToLines('')).toEqual([])
  })

  it('takes the signer from the owner fields, then the first/last name', () => {
    expect(signerFromAnswers({ owner_first_name: 'Patrick', owner_last_name: 'Covelli', first_name: 'X', last_name: 'Y' })).toBe('Patrick Covelli')
    expect(signerFromAnswers({ first_name: 'Christian', last_name: 'Ranieri' })).toBe('Christian Ranieri')
    expect(signerFromAnswers(null)).toBe('')
  })

  it('names the saved file after the company and keeps one key per job (Make again = a new version, never a second file)', () => {
    expect(einPackageName(' Italyflow  LLC ')).toBe('EIN Closure Letter - Italyflow LLC.pdf')
    expect(einPackageName('A/B Trading LLC')).toBe('EIN Closure Letter - A-B Trading LLC.pdf')
    expect(einPackageCallerKey(JOB)).toBe(`ein-closure-letter:${JOB}`)
    expect(EIN_PACKAGE_DOC_TYPE).toBe('ein_cancellation_request')
  })
})

describe('loadEinClosureFacts', () => {
  it('a job with no company takes the facts from the client wizard and offers only the job’s own EIN letter, recommended', async () => {
    seed()
    const r = await loadEinClosureFacts(JOB)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const f = r.facts
    expect([f.companyName, f.ein, f.state, f.signerName, f.hasCompany]).toEqual(['Italyflow LLC', '41-2330246', 'New Mexico', 'Christian Ranieri', false])
    expect(f.addressLines).toEqual([])
    expect(f.addressSource).toBe('none')
    expect(f.notices.map((n) => [n.documentId, n.recommended, n.mergeable, n.storeFileId !== null])).toEqual([['d-ein', true, true, true]])
    expect(f.existingLetter).toBeNull()
    expect(f.hasSignature).toBe(false)
  })

  it('never reads documents by person or by company for a job with no company (a client can own several companies, each with its own EIN letter)', async () => {
    seed()
    await loadEinClosureFacts(JOB)
    const docQueries = asked.filter((a) => a.table === 'documents')
    expect(docQueries).toHaveLength(1)
    expect(docQueries[0].filters).toEqual([['service_delivery_id', JOB]])
  })

  it('a job with a company reads that company’s documents too, takes our record over the wizard, and warns when they differ', async () => {
    hasSuite = true
    seed({ job: { account_id: 'acc-1' }, account: { company_name: 'Italyflow Holdings LLC', ein_number: '41-9999999', state_of_formation: 'New Mexico', physical_address: null } })
    const r = await loadEinClosureFacts(JOB)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.facts.companyName).toBe('Italyflow Holdings LLC')
    expect(r.facts.ein).toBe('41-9999999')
    expect(r.facts.addressSource).toBe('suite')
    expect(r.facts.addressLines).toEqual(['10225 Ulmerton Rd 3D', 'Largo, FL 33771'])
    expect(r.facts.warnings.join(' ')).toMatch(/Italyflow LLC.*Italyflow Holdings LLC/)
    expect(asked.filter((a) => a.table === 'documents').map((a) => a.filters[0])).toEqual([['service_delivery_id', JOB], ['account_id', 'acc-1']])
  })

  it('warns in plain words: no EIN copy, a file that cannot be joined, tax returns not all filed', async () => {
    seed({ submitted: { ...answers, tax_returns_filed: 'No' }, docRows: [{ ...docs[1], file_name: 'ein_letter_photo.heic' }] })
    const r = await loadEinClosureFacts(JOB)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const w = r.facts.warnings.join(' | ')
    expect(w).toMatch(/not a PDF or a picture/)
    expect(w).toMatch(/NOT all filed/)
    seed({ docRows: [] })
    const r2 = await loadEinClosureFacts(JOB)
    expect(r2.ok && r2.facts.warnings.join(' ')).toMatch(/No copy of the EIN letter/)
  })

  it('shows the letter already made', async () => {
    seed({ docRows: [...docs, { id: 'd-letter', file_name: 'EIN Closure Letter - Italyflow LLC.pdf', document_type_name: 'EIN Cancellation Request', drive_file_id: 'store:44444444-4444-4444-8444-444444444444', created_at: '2026-11-10T16:00:00Z' }] })
    const r = await loadEinClosureFacts(JOB)
    expect(r.ok && r.facts.existingLetter?.documentId).toBe('d-letter')
    expect(r.ok && r.facts.notices.map((n) => n.documentId)).toEqual(['d-ein']) // the letter itself is never offered as the "copy"
  })

  it('a trashed stored file is not offered as attachable', async () => {
    seed({ trashed: ['22222222-2222-4222-8222-222222222222'] })
    const r = await loadEinClosureFacts(JOB)
    expect(r.ok && r.facts.notices.map((n) => [n.documentId, n.storeFileId])).toEqual([['d-ein', null]])
    expect(r.ok && r.facts.warnings.join(' ')).toMatch(/not in the new storage \(or was removed\)/)
  })

  it('a name-only guess is shown but never preselected on its own; a typed EIN notice is', async () => {
    seed({ docRows: [{ ...docs[1], file_name: 'CP 575 copy.pdf', document_type_name: null }] })
    const guess = await loadEinClosureFacts(JOB)
    expect(guess.ok && guess.facts.notices.map((n) => [n.documentId, n.recommended])).toEqual([['d-ein', false]])
    seed({ docRows: [{ ...docs[1], file_name: 'scan.pdf', document_type_name: 'EIN Letter (IRS)' }] })
    const typed = await loadEinClosureFacts(JOB)
    expect(typed.ok && typed.facts.notices.map((n) => [n.documentId, n.recommended])).toEqual([['d-ein', true]])
  })

  it('when the client wrote another company or EIN than the job’s, no EIN copy is preselected and staff are told', async () => {
    seed({ job: { account_id: 'acc-1' }, account: { company_name: 'Italyflow LLC', ein_number: '41-9999999', state_of_formation: 'NM', physical_address: null } })
    const r = await loadEinClosureFacts(JOB)
    expect(r.ok && r.facts.notices.every((n) => !n.recommended)).toBe(true)
    expect(r.ok && r.facts.warnings.join(' ')).toMatch(/EIN is 41-2330246, but our record says 41-9999999/)
    expect(r.ok && r.facts.warnings.join(' ')).toMatch(/No EIN copy is preselected/)
  })

  it('the same company written another way is not a mismatch (case, punctuation, suffix)', async () => {
    seed({ job: { account_id: 'acc-1' }, account: { company_name: 'ITALYFLOW, L.L.C.', ein_number: '412330246', state_of_formation: 'NM', physical_address: null } })
    const r = await loadEinClosureFacts(JOB)
    expect(r.ok && r.facts.warnings.join(' ')).not.toMatch(/The client wrote/)
    expect(r.ok && r.facts.notices.find((n) => n.recommended)?.documentId).toBe('d-ein')
  })

  it('an empty text in our record does not hide what the client wrote', async () => {
    seed({ job: { account_id: 'acc-1' }, account: { company_name: '  ', ein_number: '', state_of_formation: '', physical_address: null } })
    const r = await loadEinClosureFacts(JOB)
    expect(r.ok && [r.facts.companyName, r.facts.ein, r.facts.state]).toEqual(['Italyflow LLC', '41-2330246', 'New Mexico'])
  })

  it('an address on file in one line becomes street + "City, ST ZIP" (nothing dropped)', async () => {
    seed({ job: { account_id: 'acc-1' }, account: { company_name: 'Italyflow LLC', ein_number: '41-2330246', state_of_formation: 'NM', physical_address: '1209 Mountain Road PL NE Ste R, Albuquerque, NM 87110' } })
    const r = await loadEinClosureFacts(JOB)
    expect(r.ok && r.facts.addressLines).toEqual(['1209 Mountain Road PL NE Ste R', 'Albuquerque, NM 87110'])
  })

  it('says so when the wizard answers cannot be told apart (another closure is open) instead of showing blanks silently', async () => {
    seed({ submitted: null })
    const r = await loadEinClosureFacts(JOB)
    expect(r.ok && r.facts.warnings.join(' ')).toMatch(/could not tell which closure wizard answers belong to this job/)
  })

  it('"not sure" about the tax returns gets its own sentence', async () => {
    seed({ submitted: { ...answers, tax_returns_filed: 'Not sure' } })
    const r = await loadEinClosureFacts(JOB)
    expect(r.ok && r.facts.warnings.join(' ')).toMatch(/not sure whether all tax returns were filed/)
    expect(r.ok && r.facts.warnings.join(' ')).not.toMatch(/NOT all filed/)
  })

  it('the box has a fingerprint that changes when what it shows changes', async () => {
    seed()
    const a = await loadEinClosureFacts(JOB)
    seed({ submitted: { ...answers, llc_name: 'Italyflow Two LLC' } })
    const b = await loadEinClosureFacts(JOB)
    expect(a.ok && b.ok && a.facts.factsHash !== b.facts.factsHash).toBe(true)
    seed()
    const again = await loadEinClosureFacts(JOB)
    expect(a.ok && again.ok && a.facts.factsHash === again.facts.factsHash).toBe(true)
  })

  it('refuses something that is not a job id with the plain "not found" (never a database sentence)', async () => {
    expect(await loadEinClosureFacts('not-a-uuid')).toMatchObject({ ok: false, status: 404, error: 'Job not found.' })
  })

  it('refuses a job that is not a Company Closure, and a missing job', async () => {
    seed({ job: { service_type: 'ITIN' } })
    expect(await loadEinClosureFacts(JOB)).toMatchObject({ ok: false, status: 400 })
    seed()
    tables.service_deliveries = []
    expect(await loadEinClosureFacts(JOB)).toMatchObject({ ok: false, status: 404 })
  })
})

describe('buildEinClosurePackage', () => {
  it('stops when the address is missing, saving nothing', async () => {
    seed()
    const r = await buildEinClosurePackage({ jobId: JOB, addressLines: [], noticeDocumentId: null })
    expect(r).toMatchObject({ ok: false, status: 400 })
    expect((r as { error?: string }).error).toMatch(/address is missing/)
    expect(saveAccount).not.toHaveBeenCalled()
    expect(saveContact).not.toHaveBeenCalled()
  })

  it('refuses a notice that is not one of the job’s own files', async () => {
    seed()
    const r = await buildEinClosurePackage({ jobId: JOB, addressLines: ['1 Main St'], noticeDocumentId: 'd-articles' })
    expect(r).toMatchObject({ ok: false, status: 400 })
    expect((r as { error?: string }).error).toMatch(/not one of this job's files/)
    expect(saveContact).not.toHaveBeenCalled()
  })

  it('a job with no company: letter + EIN copy merged (2 pages), saved through the PERSON’s storage as an EIN cancellation request on the job', async () => {
    seed()
    saveContact.mockResolvedValue({ route: 'store', fileId: 'f', pointer: 'store:f', documentRowId: 'doc-new', status: 'created' })
    const r = await buildEinClosurePackage({ jobId: JOB, addressLines: ['1209 Mountain Road PL NE Ste R', 'Albuquerque, NM 87110'], noticeDocumentId: 'd-ein', now: new Date('2026-11-10T15:00:00Z') })
    expect(r).toMatchObject({ ok: true, documentId: 'doc-new', name: 'EIN Closure Letter - Italyflow LLC.pdf', pages: 2, attachedNotice: 'ein_letter_Italyflow_LLC_CP_575_B.pdf' })
    expect(saveAccount).not.toHaveBeenCalled()
    const arg = saveContact.mock.calls[0][0]
    expect(arg).toMatchObject({ contactId: 'c-1', documentType: 'ein_cancellation_request', callerKey: `ein-closure-letter:${JOB}`, portalVisible: false, mimeType: 'application/pdf' })
    expect(arg.row).toEqual({ service_delivery_id: JOB, flow_stage: 'IRS Closure', status: 'classified' })
    const saved = await PDFDocument.load(arg.bytes)
    expect(saved.getPageCount()).toBe(2)
  })

  it('without a copy the package is the letter alone (1 page) and the sentence about a copy is not printed', async () => {
    seed()
    saveContact.mockResolvedValue({ route: 'store', fileId: 'f', pointer: 'store:f', documentRowId: 'doc-new', status: 'created' })
    const r = await buildEinClosurePackage({ jobId: JOB, addressLines: ['1 Main St'], noticeDocumentId: null })
    expect(r).toMatchObject({ ok: true, pages: 1, attachedNotice: null })
  })

  it('a job with a company is saved in the COMPANY’s storage, folder 1. Company', async () => {
    hasSuite = true
    seed({ job: { account_id: 'acc-1' }, account: { company_name: 'Italyflow LLC', ein_number: '41-2330246', state_of_formation: 'New Mexico', physical_address: null } })
    saveAccount.mockResolvedValue({ route: 'store', fileId: 'f', pointer: 'store:f', documentRowId: 'doc-co', status: 'created' })
    const r = await buildEinClosurePackage({ jobId: JOB, addressLines: ['10225 Ulmerton Rd 3D', 'Largo, FL 33771'], noticeDocumentId: 'd-ein' })
    expect(r).toMatchObject({ ok: true, documentId: 'doc-co' })
    expect(saveContact).not.toHaveBeenCalled()
    expect(saveAccount.mock.calls[0][0]).toMatchObject({ accountId: 'acc-1', folder: 'company', documentType: 'ein_cancellation_request', portalVisible: false })
  })

  it('says so plainly when the company’s files are not in the new storage, and when the company is being moved', async () => {
    seed({ job: { account_id: 'acc-1' }, account: { company_name: 'Italyflow LLC', ein_number: '41-2330246', state_of_formation: 'NM', physical_address: null } })
    saveAccount.mockResolvedValueOnce({ route: 'drive' })
    expect(await buildEinClosurePackage({ jobId: JOB, addressLines: ['1 Main St'], noticeDocumentId: null })).toMatchObject({ ok: false, status: 409 })
    saveAccount.mockRejectedValueOnce(new FakeMoving('being moved'))
    expect(await buildEinClosurePackage({ jobId: JOB, addressLines: ['1 Main St'], noticeDocumentId: null })).toMatchObject({ ok: false, status: 409, error: 'being moved' })
  })

  it('a copy that is not a readable PDF/picture is reported, not saved', async () => {
    seed()
    noticeBytes = Buffer.from('this is not a pdf')
    const r = await buildEinClosurePackage({ jobId: JOB, addressLines: ['1 Main St'], noticeDocumentId: 'd-ein' })
    expect(r).toMatchObject({ ok: false, status: 400 })
    expect((r as { error?: string }).error).toMatch(/could not be attached/)
    expect(saveContact).not.toHaveBeenCalled()
  })
})


describe('buildEinClosurePackage — guards', () => {
  it('only an OPEN closure gets a letter', async () => {
    seed({ job: { status: 'cancelled' } })
    const r = await buildEinClosurePackage({ jobId: JOB, addressLines: ['1 Main St'], noticeDocumentId: null })
    expect(r).toMatchObject({ ok: false, status: 409 })
    expect((r as { error?: string }).error).toMatch(/is cancelled/)
    expect(saveContact).not.toHaveBeenCalled()
  })

  it('nothing is made when what staff were looking at changed (the facts fingerprint no longer matches), and the first call with the right one works', async () => {
    seed()
    const facts = await loadEinClosureFacts(JOB)
    expect(facts.ok).toBe(true)
    if (!facts.ok) return
    const stale = await buildEinClosurePackage({ jobId: JOB, addressLines: ['1 Main St'], noticeDocumentId: null, factsHash: 'old' })
    expect(stale).toMatchObject({ ok: false, status: 409 })
    expect((stale as { error?: string }).error).toMatch(/Something changed/)
    expect(saveContact).not.toHaveBeenCalled()
    saveContact.mockResolvedValue({ route: 'store', fileId: 'f', pointer: 'store:f', documentRowId: 'doc-new', status: 'created' })
    expect(await buildEinClosurePackage({ jobId: JOB, addressLines: ['1 Main St'], noticeDocumentId: null, factsHash: facts.facts.factsHash })).toMatchObject({ ok: true })
  })

  it('an address that does not fit the letter is refused with a plain sentence instead of being cut', async () => {
    seed()
    const tooMany = await buildEinClosurePackage({ jobId: JOB, addressLines: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], noticeDocumentId: null })
    expect(tooMany).toMatchObject({ ok: false, status: 400 })
    expect((tooMany as { error?: string }).error).toMatch(/7 lines/)
    const tooLong = await buildEinClosurePackage({ jobId: JOB, addressLines: ['x'.repeat(130)], noticeDocumentId: null })
    expect((tooLong as { error?: string }).error).toMatch(/longer than 120/)
    expect(saveContact).not.toHaveBeenCalled()
  })

  it('a long address that DOES fit is made in full on one page (it wraps instead of running off the page)', async () => {
    seed()
    saveContact.mockResolvedValue({ route: 'store', fileId: 'f', pointer: 'store:f', documentRowId: 'doc-new', status: 'created' })
    const r = await buildEinClosurePackage({ jobId: JOB, addressLines: ['1209 Mountain Road PL NE Ste R Building Twelve Floor Three Room Nine', 'Albuquerque, NM 87110'], noticeDocumentId: null })
    expect(r).toMatchObject({ ok: true, pages: 1 })
  })

  it('characters the letter cannot print are refused with the characters named, not printed as empty boxes', async () => {
    seed()
    const r = await buildEinClosurePackage({ jobId: JOB, addressLines: ['北京 1 Main St', 'Beijing'], noticeDocumentId: null })
    expect(r).toMatchObject({ ok: false, status: 400 })
    expect((r as { error?: string }).error).toMatch(/cannot print these characters.*北/)
    expect(saveContact).not.toHaveBeenCalled()
  })

  it('says the real reason when the storage refuses (a closed company), not a general sentence', async () => {
    seed({ job: { account_id: 'acc-1' }, account: { company_name: 'Italyflow LLC', ein_number: '41-2330246', state_of_formation: 'NM', physical_address: null } })
    tables.accounts[0].status = 'Closed'
    saveAccount.mockResolvedValueOnce({ route: 'drive' })
    const r = await buildEinClosurePackage({ jobId: JOB, addressLines: ['1 Main St'], noticeDocumentId: null })
    expect(r).toMatchObject({ ok: false, status: 409 })
    expect((r as { error?: string }).error).toMatch(/This company is closed, so nothing new can be saved for it\. The letter could not be saved\./)
  })
})

describe('the client’s drawn signature (closure wizard, part F step 2)', () => {
  const sigDoc = { id: 'd-sig', file_name: 'signature_image_ab12cd34_signature.png', document_type_name: null, drive_file_id: `store:${SIG_STORE_ID}`, created_at: '2026-11-10T15:22:03Z' }
  const consented = { ...answers, signature_image: ['closure/x/signature_image_ab12cd34_signature.png'], signature_consent: 'text', signature_signed_at: '2026-11-10T18:30:00.000Z' }

  it('is used only when the file is on the job AND the server recorded the client’s consent', async () => {
    seed({ submitted: consented, docRows: [...docs, sigDoc] })
    const r = await loadEinClosureFacts(JOB)
    expect(r.ok && [r.facts.hasSignature, r.facts.signedAt, r.facts.signatureStoreFileId]).toEqual([true, '2026-11-10T18:30:00.000Z', SIG_STORE_ID])
    expect(r.ok && r.facts.notices.map((n) => n.documentId)).toEqual(['d-ein']) // the picture is never offered as the EIN letter copy
  })

  it('a signature file with no consent record is NOT used, and staff are told', async () => {
    seed({ submitted: { ...answers, signature_image: consented.signature_image }, docRows: [...docs, sigDoc] })
    const r = await loadEinClosureFacts(JOB)
    expect(r.ok && r.facts.hasSignature).toBe(false)
    expect(r.ok && r.facts.warnings.join(' ')).toMatch(/consent was not recorded/)
  })

  it('a signature that is not in the new storage cannot be used', async () => {
    seed({ submitted: consented, docRows: [...docs, { ...sigDoc, drive_file_id: 'drive-file-id' }] })
    const r = await loadEinClosureFacts(JOB)
    expect(r.ok && r.facts.hasSignature).toBe(false)
    expect(r.ok && r.facts.warnings.join(' ')).toMatch(/not in the new storage/)
  })

  it('goes onto the letter: the saved package says it is signed', async () => {
    seed({ submitted: consented, docRows: [...docs, sigDoc] })
    saveContact.mockResolvedValue({ route: 'store', fileId: 'f', pointer: 'store:f', documentRowId: 'doc-new', status: 'created' })
    const r = await buildEinClosurePackage({ jobId: JOB, addressLines: ['1 Main St'], noticeDocumentId: null })
    expect(r).toMatchObject({ ok: true, signed: true })
    const withSig = saveContact.mock.calls[0][0].bytes as Buffer
    seed({ submitted: answers })
    saveContact.mockClear()
    saveContact.mockResolvedValue({ route: 'store', fileId: 'f', pointer: 'store:f', documentRowId: 'doc-2', status: 'created' })
    const plain = await buildEinClosurePackage({ jobId: JOB, addressLines: ['1 Main St'], noticeDocumentId: null })
    expect(plain).toMatchObject({ ok: true, signed: false })
    expect(withSig.length).toBeGreaterThan((saveContact.mock.calls[0][0].bytes as Buffer).length - 1) // the picture is inside
  })

  it('a signature file that is not a real PNG is left out with a plain warning — the letter still gets made, with a line to sign by hand', async () => {
    sigBytes = Buffer.from('%PDF-1.7 pretending to be a picture')
    seed({ submitted: consented, docRows: [...docs, sigDoc] })
    saveContact.mockResolvedValue({ route: 'store', fileId: 'f', pointer: 'store:f', documentRowId: 'doc-new', status: 'created' })
    const r = await buildEinClosurePackage({ jobId: JOB, addressLines: ['1 Main St'], noticeDocumentId: null })
    expect(r).toMatchObject({ ok: true, signed: false })
    expect(r.ok && r.warnings.join(' ')).toMatch(/not a usable PNG/)
  })

  it('a PNG with a valid header but unusable contents (or a huge size) is left out with a plain warning — the letter is still made', async () => {
    const head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const ihdr = (w: number, h: number) => { const b = Buffer.alloc(25); b.writeUInt32BE(13, 0); b.write('IHDR', 4); b.writeUInt32BE(w, 8); b.writeUInt32BE(h, 12); return b }
    for (const [bytes, why] of [[Buffer.concat([head, ihdr(400, 160), Buffer.from('truncated nonsense')]), /could not be read/], [Buffer.concat([head, ihdr(60000, 60000)]), /not a usable size/]] as const) {
      sigBytes = bytes
      seed({ submitted: consented, docRows: [...docs, sigDoc] })
      saveContact.mockResolvedValue({ route: 'store', fileId: 'f', pointer: 'store:f', documentRowId: 'doc-new', status: 'created' })
      const r = await buildEinClosurePackage({ jobId: JOB, addressLines: ['1 Main St'], noticeDocumentId: null })
      expect(r).toMatchObject({ ok: true, signed: false })
      expect(r.ok && r.warnings.join(' ')).toMatch(why)
    }
  })

  it('uses THE file the answers name, not just any file called signature_image…', async () => {
    const other = { ...sigDoc, id: 'd-sig-old', file_name: 'signature_image_00000000_signature.png', drive_file_id: 'store:66666666-6666-4666-8666-666666666666', created_at: '2026-11-11T09:00:00Z' }
    seed({ submitted: consented, docRows: [...docs, sigDoc, other] })
    const r = await loadEinClosureFacts(JOB)
    expect(r.ok && r.facts.signatureStoreFileId).toBe(SIG_STORE_ID) // the newer, different file is ignored
  })

  it('tells staff when the client signed but the picture is not on the job yet (still filing) — and the letter has a line to sign by hand', async () => {
    seed({ submitted: consented, docRows: docs })
    const r = await loadEinClosureFacts(JOB)
    expect(r.ok && r.facts.hasSignature).toBe(false)
    expect(r.ok && r.facts.warnings.join(' ')).toMatch(/drew a signature, but its picture is not on this job yet/)
  })

  it('a signature given for another company or EIN than this letter is NOT used, and staff are told why', async () => {
    seed({ job: { account_id: 'acc-1' }, account: { company_name: 'Italyflow Holdings LLC', ein_number: '41-9999999', state_of_formation: 'NM', physical_address: null }, submitted: consented, docRows: [...docs, sigDoc] })
    const r = await loadEinClosureFacts(JOB)
    expect(r.ok && r.facts.hasSignature).toBe(false)
    expect(r.ok && r.facts.warnings.join(' ')).toMatch(/signed a letter for "Italyflow LLC" \(EIN 41-2330246\), but this letter is for "Italyflow Holdings LLC" \(EIN 41-9999999\)/)
  })

  it('the same company written another way keeps the signature', async () => {
    seed({ job: { account_id: 'acc-1' }, account: { company_name: 'ITALYFLOW L.L.C.', ein_number: '412330246', state_of_formation: 'NM', physical_address: null }, submitted: consented, docRows: [...docs, sigDoc] })
    const r = await loadEinClosureFacts(JOB)
    expect(r.ok && r.facts.hasSignature).toBe(true)
  })

  it('a trashed signature file is not used', async () => {
    seed({ submitted: consented, docRows: [...docs, sigDoc], trashed: [SIG_STORE_ID] })
    const r = await loadEinClosureFacts(JOB)
    expect(r.ok && r.facts.hasSignature).toBe(false)
  })
})
