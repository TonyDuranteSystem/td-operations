/**
 * Stop Drive S1d round 5.
 *  1. passports: ONLY passport_owner* is the owner's passport; passport_member_* never goes to the owner's storage nor feeds the owner's data;
 *     a passport of unclear owner is not filed; OCR checks the name before writing
 *  2. ensureCompanyStorage: never a second owner while the buyer's formation owns one (two open formations); a study-only owner is not live
 *  3. an open company with no folder and no storage gets its storage opened by the shared save helpers (no dead end); Closed/Cancelled do not
 *  4. every Drive link shape gives the folder id
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const st = vi.hoisted(() => ({
  rows: {} as Record<string, unknown>,
  recorded: [] as Array<{ table: string; op: string; payload: unknown }>,
  rpcs: [] as string[],
  saved: [] as Array<Record<string, unknown>>,
  persons: [] as string[],
  alarms: [] as string[],
  companyState: 'drive' as 'drive' | 'store' | 'moving',
  liveOwner: null as string | null,
  ownerRow: { study_only: false } as Record<string, unknown>,
  ocr: { fullText: '' },
}))

vi.mock('@/lib/supabase-admin', async () => {
  const h = await import('./_legacy-drive-mocks')
  const base = h.makeSupabase(st.rows, st.recorded as never)
  const storage = { from: () => ({ download: async (p: string) => ({ data: { size: 4, type: 'application/pdf', arrayBuffer: async () => new TextEncoder().encode('%PDF').buffer }, error: null, p }) }) }
  const from = (t: string) => (t === 'store_owners' && st.rows.__ownerRow ? (() => { const c: Record<string, unknown> = {}; for (const m of ['select', 'eq', 'in']) c[m] = () => c; c.maybeSingle = async () => ({ data: st.ownerRow, error: null }); c.then = (r: (v: unknown) => unknown) => Promise.resolve({ data: st.rows.store_owners ?? [], error: null }).then(r); return c })() : base.from(t))
  return { supabaseAdmin: { from, storage, rpc: async (f: string) => { st.rpcs.push(f); if (f === 'store_ensure_owner') st.companyState = 'store'; return { data: 'owner-new', error: null } } } }
})
vi.mock('@/lib/crm-store/browse', () => ({ storeOwnerForAccount: async () => 'company-owner' }))
vi.mock('@/lib/crm-store/switched-drive-guard', () => ({ companyDocState: async () => st.companyState, liveOwnerOfAccount: async () => st.liveOwner }))
vi.mock('@/lib/crm-store/formation-pilot', () => ({
  COMPANY_TEMPLATE: 'company', storeSafeFolderName: (x: string) => x,
  savePilotFile: async (i: Record<string, unknown>) => { st.saved.push(i); return { status: 'created', fileId: 'f' } },
  ensurePersonOwner: async (id: string) => { st.persons.push(id); return `person-owner-${id}` },
  raisePilotAlarm: async (kind: string) => { st.alarms.push(kind) },
}))
vi.mock('@/lib/docai', () => ({ ocrDriveFile: async () => st.ocr, ocrRawContent: async () => st.ocr }))

beforeEach(() => {
  st.recorded.length = 0; st.rpcs.length = 0; st.saved.length = 0; st.persons.length = 0; st.alarms.length = 0
  st.companyState = 'drive'; st.liveOwner = null; st.ownerRow = { study_only: false }
  for (const k of Object.keys(st.rows)) delete st.rows[k]
})

describe('passports in saveUploadsToStoreForAccount', () => {
  const OWNER = 'onboarding/c1/passport_owner_ab_front.pdf'
  const M1 = 'onboarding/c1/passport_member_1_cd_front.pdf'
  const M2 = 'onboarding/c1/passport_member_2_ef_front.pdf'
  const EIN = 'onboarding/c1/ein_letter_gh.pdf'
  it('the OWNER passport goes to the owner\'s own storage; member passports go NOWHERE here (not the owner\'s storage, not the company\'s); the data read is the owner\'s file', async () => {
    const { saveUploadsToStoreForAccount } = await import('@/lib/crm-store/account-uploads')
    const r = await saveUploadsToStoreForAccount({ accountId: 'acc-1', flow: 'onboarding', paths: [OWNER, M1, M2, EIN], passportContact: { contactId: 'c1', name: 'Owner Person' } })
    expect(st.persons).toEqual(['c1'])
    const byName = (n: string) => st.saved.find((s) => s.name === n.split('/').pop())
    expect(byName(OWNER)).toMatchObject({ ownerId: 'person-owner-c1', folderKind: 'personal', documentType: 'passport' })
    expect(byName(M1)).toBeUndefined(); expect(byName(M2)).toBeUndefined()
    expect(byName(EIN)).toMatchObject({ ownerId: 'company-owner', folderKind: 'company' })
    expect(r.heldForMembers).toBe(2)
    expect(r.passport?.fileName).toBe('passport_owner_ab_front.pdf') // first/owner, never the last member
    expect(r.failed).toEqual([])
  })
  it('a passport whose owner cannot be told from its name is NOT filed, is reported, and staff are alarmed', async () => {
    const { saveUploadsToStoreForAccount } = await import('@/lib/crm-store/account-uploads')
    const r = await saveUploadsToStoreForAccount({ accountId: 'acc-1', flow: 'tax-intake', paths: ['tax/c1/passport_copy_xy.pdf'], passportContact: { contactId: 'c1', name: 'X' } })
    expect(st.saved).toEqual([])
    expect(r.failed[0].error).toMatch(/whose passport/)
    expect(st.alarms).toContain('store_unmapped_upload')
  })
  it('passportKindOf', async () => {
    const { passportKindOf } = await import('@/lib/crm-store/account-uploads')
    expect(passportKindOf('passport_owner_x.pdf')).toBe('owner'); expect(passportKindOf('passport_member_3_x.pdf')).toBe('member')
    expect(passportKindOf('passport_image_x.pdf')).toBe('unknown'); expect(passportKindOf('ein_letter.pdf')).toBe('none')
    // the portal wizard names a member's passport member_{i}_member_passport
    expect(passportKindOf('member_0_member_passport_ab_front.pdf')).toBe('member')
  })
  it('memberPassportPathFor finds member i in both naming schemes and never mixes members up', async () => {
    const { memberPassportPathFor } = await import('@/lib/crm-store/account-uploads')
    const paths = ['onboarding/c/passport_owner_a.pdf', 'onboarding/c/member_0_member_passport_b.pdf', 'onboarding/c/member_1_member_passport_c.pdf', 'onboarding/c/passport_member_2_d.pdf']
    expect(memberPassportPathFor(paths, 0)).toBe(paths[1]); expect(memberPassportPathFor(paths, 1)).toBe(paths[2]); expect(memberPassportPathFor(paths, 2)).toBe(paths[3])
    expect(memberPassportPathFor(paths, 3)).toBeUndefined(); expect(memberPassportPathFor(null, 0)).toBeUndefined()
  })
})

describe('passport data is written only to the person on the passport', () => {
  const MRZ = (name: string) => `P<ITA${name}<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<\nAB1234567<8ITA0108094M3012315<<<<<<<<<<<<<<06`
  it('passportNameMatchesPerson: order-free, accent-free, needs two shared parts', async () => {
    const { passportNameMatchesPerson } = await import('@/lib/jobs/passport-writeback')
    expect(passportNameMatchesPerson('Mario Rossi', 'Rossi Mario')).toBe(true)
    expect(passportNameMatchesPerson('José Núñez Pérez', 'Jose Nunez')).toBe(true)
    expect(passportNameMatchesPerson('Luca Bianchi', 'Mario Rossi')).toBe(false)
    expect(passportNameMatchesPerson(null, 'Mario Rossi')).toBe(false)
  })
  it('a member\'s passport read for the OWNER writes NOTHING (the names differ)', async () => {
    st.ocr = { fullText: MRZ('BIANCHI<<LUCA') }
    st.rows.contacts = { passport_number: null }
    const { extractAndStorePassportData } = await import('@/lib/jobs/passport-writeback')
    const r = await extractAndStorePassportData({ contact_id: 'owner', content: new ArrayBuffer(4), file_name: 'p.pdf', mime_type: 'application/pdf', contact_name: 'Mario Rossi', account_id: 'acc-1' })
    expect(r.status).toBe('skipped')
    expect(r.detail).toMatch(/does not match/)
    expect(st.recorded.filter((x) => x.table === 'contacts' && x.op === 'update')).toEqual([])
  })
  it('the same name: the data is written', async () => {
    st.ocr = { fullText: MRZ('ROSSI<<MARIO') }
    st.rows.contacts = { passport_number: null }
    const { extractAndStorePassportData } = await import('@/lib/jobs/passport-writeback')
    const r = await extractAndStorePassportData({ contact_id: 'owner', content: new ArrayBuffer(4), file_name: 'p.pdf', mime_type: 'application/pdf', contact_name: 'Mario Rossi' })
    expect(r.status).toBe('ok')
    expect(st.recorded.some((x) => x.table === 'contacts' && x.op === 'update')).toBe(true)
  })
})

describe('ensureCompanyStorage', () => {
  it('two open formations, one with a live formation owner: NO second company owner is inserted', async () => {
    st.rows.account_contacts = [{ contact_id: 'buyer' }]
    st.rows.service_deliveries = [{ id: 'sd1', account_id: null }, { id: 'sd2', account_id: null }]
    st.rows.store_owners = [{ id: 'formation-owner-1' }]
    const { ensureCompanyStorage } = await import('@/lib/crm-store/company-storage')
    await expect(ensureCompanyStorage('acc-1', 'New LLC')).rejects.toMatchObject({ name: 'FormationOwnerPendingError' })
    expect(st.rpcs).toEqual([])
  })
  it('no formation owner: the storage is opened once', async () => {
    st.rows.account_contacts = [{ contact_id: 'buyer' }]
    st.rows.service_deliveries = [{ id: 'sd1', account_id: null }]
    st.rows.store_owners = []
    const { ensureCompanyStorage } = await import('@/lib/crm-store/company-storage')
    expect(await ensureCompanyStorage('acc-1', 'New LLC')).toBe('owner-new')
    expect(st.rpcs).toEqual(['store_ensure_owner', 'store_apply_template'])
  })
  it('a study-only owner handed back is NOT a live storage: error, no folders made', async () => {
    st.rows.account_contacts = []
    st.rows.__ownerRow = true; st.ownerRow = { study_only: true }
    const { ensureCompanyStorage } = await import('@/lib/crm-store/company-storage')
    await expect(ensureCompanyStorage('acc-1', 'New LLC')).rejects.toThrow(/study copy/)
    expect(st.rpcs).toEqual(['store_ensure_owner'])
  })
  it('the folder helper turns "formation owns it" into the store-owned refusal (callers take their storage branch)', async () => {
    st.rows.account_contacts = [{ contact_id: 'buyer' }]; st.rows.service_deliveries = [{ id: 'sd1', account_id: null }]; st.rows.store_owners = [{ id: 'fo' }]
    st.rows.accounts = { status: 'Active', drive_folder_id: null, gdrive_folder_url: null }
    vi.doMock('@/lib/crm-store/browse', () => ({ assertNotStoreOwnedAccount: async () => {}, storeOwnerForAccount: async () => 'company-owner' }))
    const { ensureCompanyFolder } = await import('@/lib/drive-folder-utils')
    const { isStoreOwnedRefusal } = await import('@/lib/crm-store/account-uploads')
    let err: unknown
    try { await ensureCompanyFolder('acc-1', 'New LLC', 'Wyoming') } catch (e) { err = e }
    expect(isStoreOwnedRefusal(err)).toBe(true)
    expect(st.rpcs).toEqual([])
  })
})

describe('no dead end for an open company with no folder and no storage', () => {
  it('openStorageForOpenCompany: Active/Suspended/Offboarding/Pending with no folder -> opened; Closed/Cancelled and folder-holders -> not', async () => {
    const { openStorageForOpenCompany } = await import('@/lib/crm-store/no-storage')
    for (const [status, folder, expected] of [['Active', null, true], ['Suspended', null, true], ['Offboarding', null, true], ['Closed', null, false], ['Cancelled', 'F', false], ['Offboarding', 'F', false]] as const) {
      st.rpcs.length = 0; st.companyState = 'drive'; st.rows.accounts = { company_name: 'Acme', status, drive_folder_id: folder, gdrive_folder_url: null }; st.rows.account_contacts = []
      expect(await openStorageForOpenCompany('a'), `${status}/${folder}`).toBe(expected)
      expect(st.rpcs.length > 0, `${status}/${folder} rpc`).toBe(expected)
    }
  })
  it('a company in storage or moving is left alone', async () => {
    const { openStorageForOpenCompany } = await import('@/lib/crm-store/no-storage')
    st.rows.accounts = { company_name: 'Acme', status: 'Active', drive_folder_id: null }
    st.companyState = 'store'; expect(await openStorageForOpenCompany('a')).toBe(false)
    st.companyState = 'moving'; expect(await openStorageForOpenCompany('a')).toBe(false)
    expect(st.rpcs).toEqual([])
  })
  it('receiveVerdictFor: an open company with no folder CAN receive (its storage is opened); a Closed one cannot', async () => {
    const { receiveVerdictFor } = await import('@/lib/crm-store/no-storage')
    st.rows.accounts = { company_name: 'Acme', status: 'Active', drive_folder_id: null, gdrive_folder_url: null }; st.rows.account_contacts = []
    st.liveOwner = null
    // after opening, the company is in storage
    const guard = await import('@/lib/crm-store/switched-drive-guard')
    void guard
    st.companyState = 'drive'
    const v = await receiveVerdictFor('a')
    expect(st.rpcs.length).toBeGreaterThan(0)
    expect(v.ok).toBe(true)
    st.companyState = 'drive'
    st.rpcs.length = 0; st.rows.accounts = { company_name: 'Acme', status: 'Closed', drive_folder_id: null, gdrive_folder_url: null }
    expect((await receiveVerdictFor('a'))).toMatchObject({ ok: false, reason: 'archived' })
    expect(st.rpcs).toEqual([])
  })
  it('saveDocumentForAccount opens the storage and saves in it', async () => {
    const { saveDocumentForAccount } = await import('@/lib/crm-store/save-for-account')
    let state: 'drive' | 'store' = 'drive'
    const opened: string[] = []
    const save = vi.fn(async () => ({ status: 'created', fileId: 'f1' }))
    const r = await saveDocumentForAccount(
      { accountId: 'a1', name: 'x.pdf', bytes: Buffer.from('x'), mimeType: 'application/pdf', folder: 'company', documentType: null, callerKey: 'k' },
      { state: async () => state, liveOwner: async () => 'new-owner', personOwner: async () => 'p', save: save as never, upsertRow: (async () => ({ id: 'row', inserted: true })) as never, pointer: (id: string) => `store:${id}`,
        openStorage: async (id: string) => { opened.push(id); state = 'store'; return true } },
    )
    expect(r.route).toBe('store'); expect(opened).toEqual(['a1']); expect(save).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'new-owner' }))
  })
})

describe('Drive link shapes', () => {
  it('every form gives the id', async () => {
    const { driveIdFromUrl, folderIdOf } = await import('@/lib/crm-store/no-storage')
    for (const u of ['https://drive.google.com/drive/folders/AbC_123-x', 'https://drive.google.com/drive/u/0/folders/AbC_123-x?usp=sharing', 'https://drive.google.com/open?id=AbC_123-x', 'https://drive.google.com/drive/folders?id=AbC_123-x']) expect(driveIdFromUrl(u), u).toBe('AbC_123-x')
    expect(driveIdFromUrl('https://example.com/')).toBeNull(); expect(driveIdFromUrl(null)).toBeNull()
    expect(folderIdOf({ drive_folder_id: null, gdrive_folder_url: 'https://drive.google.com/open?id=ZZ9' })).toBe('ZZ9')
    expect(folderIdOf({ drive_folder_id: 'REAL', gdrive_folder_url: 'https://drive.google.com/open?id=ZZ9' })).toBe('REAL')
  })
})
