import { describe, it, expect, vi, beforeEach } from 'vitest'

// Stop Drive S1d: ensureCompanyFolder / ensureContactFolder NEVER create a Drive folder or anything inside one.
// The REAL decisions (legacy-drive.ts) run; only the database rows, the storage state and Drive are fakes. Drive fails on any write.
const st = vi.hoisted(() => ({
  rows: {} as Record<string, unknown>,
  recorded: [] as Array<{ table: string; op: string; payload: unknown }>,
  driveWrites: [] as string[],
  driveReads: [] as string[],
  companyState: 'drive' as 'drive' | 'store' | 'moving',
  personOwner: false,
  openedCompanyStorage: [] as string[],
  openedPersonStorage: [] as string[],
  alarms: [] as Array<{ kind: string; details: Record<string, unknown> }>,
}))
vi.mock('@/lib/supabase-admin', async () => ({ supabaseAdmin: (await import('./_legacy-drive-mocks')).makeSupabase(st.rows, st.recorded as never) }))
vi.mock('@/lib/google-drive', async () => (await import('./_legacy-drive-mocks')).driveSpy(st.driveWrites, st.driveReads))
vi.mock('@/lib/crm-store/switched-drive-guard', () => ({
  companyDocState: async () => st.companyState,
  liveOwnerOfContact: async () => (st.personOwner ? 'person-owner' : null),
}))
vi.mock('@/lib/crm-store/browse', () => ({
  assertNotStoreOwnedAccount: async () => {
    if (st.companyState === 'store') { const m = await import('@/lib/crm-store/account-uploads'); throw new m.StoreOwnedAccountError('in storage') }
  },
}))
vi.mock('@/lib/crm-store/person-drive-guard', async () => {
  const real = await vi.importActual<typeof import('@/lib/crm-store/person-drive-guard')>('@/lib/crm-store/person-drive-guard')
  return { ...real, assertPersonFilesStillOnDrive: async () => { if (st.personOwner) throw new real.PersonFilesInStorageError() } }
})
vi.mock('@/lib/crm-store/company-storage', () => ({ ensureCompanyStorage: async (id: string) => { st.openedCompanyStorage.push(id); return 'owner-1' } }))
vi.mock('@/lib/crm-store/formation-pilot', () => ({
  raisePilotAlarm: async (kind: string, details: Record<string, unknown>) => { st.alarms.push({ kind, details }) },
  ensurePersonOwner: async (id: string) => { st.openedPersonStorage.push(id); return 'p-owner' },
}))

const acct = (status: string, folder: string | null) => { st.rows.accounts = { status, drive_folder_id: folder, gdrive_folder_url: null, company_name: 'Acme LLC' } }
const FIVE = ['1. Company', '2. Contacts', '3. Tax', '4. Banking', '5. Correspondence']

beforeEach(async () => {
  vi.clearAllMocks()
  for (const k of Object.keys(st.rows)) delete st.rows[k]
  st.recorded.length = 0; st.driveWrites.length = 0; st.driveReads.length = 0; st.alarms.length = 0
  st.openedCompanyStorage.length = 0; st.openedPersonStorage.length = 0
  st.companyState = 'drive'; st.personOwner = false
  const m = await import('@/lib/crm-store/legacy-drive')
  m.forgetRecentAlarms()
  st.rows.service_deliveries = null
})

describe('ensureCompanyFolder', () => {
  it('a company in storage: refused by the storage guard, zero Drive calls', async () => {
    st.companyState = 'store'; acct('Active', null)
    const { ensureCompanyFolder } = await import('@/lib/drive-folder-utils')
    await expect(ensureCompanyFolder('a1', 'Acme LLC', 'Wyoming')).rejects.toMatchObject({ name: 'StoreOwnedAccountError' })
    expect(st.driveWrites).toEqual([]); expect(st.driveReads).toEqual([])
  })
  it.each(['Closed', 'closed', 'Cancelled'])('%s company with an old folder: refused + ONE alarm, zero Drive calls', async (status) => {
    acct(status, 'F-old')
    const { ensureCompanyFolder } = await import('@/lib/drive-folder-utils')
    await expect(ensureCompanyFolder('a1', 'Acme LLC', 'Wyoming')).rejects.toMatchObject({ name: 'LegacyDriveRefusedError', reason: 'archived' })
    expect(st.driveWrites).toEqual([]); expect(st.driveReads).toEqual([])
    expect(st.alarms.map((a) => a.kind)).toEqual(['drive_write_refused'])
    expect(st.openedCompanyStorage).toEqual([])
  })
  it('an open company with NO folder and NO storage (made by onboarding / place-client / tax intake): its storage is OPENED and the caller takes the storage branch — no Drive call', async () => {
    acct('Active', null)
    const { ensureCompanyFolder } = await import('@/lib/drive-folder-utils')
    const { isStoreOwnedRefusal } = await import('@/lib/crm-store/account-uploads')
    let err: unknown
    try { await ensureCompanyFolder('a1', 'Acme LLC', 'Wyoming') } catch (e) { err = e }
    expect(isStoreOwnedRefusal(err)).toBe(true)
    expect(st.openedCompanyStorage).toEqual(['a1'])
    expect(st.driveWrites).toEqual([]); expect(st.driveReads).toEqual([])
    expect(st.alarms).toEqual([])
  })
  it('a company left on Drive: gets its folder back; a MISSING subfolder is not created', async () => {
    acct('Offboarding', 'F-rebis')
    const { ensureCompanyFolder } = await import('@/lib/drive-folder-utils')
    const r = await ensureCompanyFolder('a1', 'REBIS', 'Delaware')
    expect(r).toMatchObject({ folderId: 'F-rebis', created: false })
    expect(st.driveWrites).toEqual([])
    expect(r.subfolders).toEqual({}) // the (fake) folder is empty: nothing was made up
  })
})

describe('ensureContactFolder', () => {
  const links = (ids: string[]) => { st.rows.account_contacts = ids.map((id) => ({ account_id: id })) }
  it('a person whose company is in storage: their OWN storage is opened, the caller takes the storage branch, zero Drive calls', async () => {
    st.companyState = 'store'; acct('Active', null); st.rows.contacts = { drive_folder_id: null, gdrive_folder_url: null }; links(['a1'])
    const { ensureContactFolder } = await import('@/lib/drive-folder-utils')
    await expect(ensureContactFolder('c1', 'Maria Verdi')).rejects.toMatchObject({ name: 'PersonFilesInStorageError' })
    expect(st.openedPersonStorage).toEqual(['c1'])
    expect(st.driveWrites).toEqual([]); expect(st.driveReads).toEqual([])
  })
  it('a lead with no company: own storage opened, never a Contacts/<name> folder', async () => {
    st.rows.contacts = { drive_folder_id: null, gdrive_folder_url: null }; links([])
    const { ensureContactFolder } = await import('@/lib/drive-folder-utils')
    await expect(ensureContactFolder('c2', 'New Lead')).rejects.toMatchObject({ name: 'PersonFilesInStorageError' })
    expect(st.openedPersonStorage).toEqual(['c2']); expect(st.driveWrites).toEqual([])
  })
  it('a person only of a CLOSED company: refused with an alarm (no storage is opened for them)', async () => {
    acct('Closed', 'F-old'); st.rows.contacts = { drive_folder_id: 'P-old', gdrive_folder_url: null }; links(['a1'])
    const { ensureContactFolder } = await import('@/lib/drive-folder-utils')
    await expect(ensureContactFolder('c3', 'Old Person')).rejects.toMatchObject({ name: 'LegacyDriveRefusedError', reason: 'archived' })
    expect(st.openedPersonStorage).toEqual([]); expect(st.driveReads).toEqual([])
    expect(st.alarms.map((a) => a.kind)).toEqual(['drive_write_refused'])
  })
  it('a person of a left-on-Drive company: their own folder back, nothing created', async () => {
    acct('Offboarding', 'F-rebis'); st.rows.contacts = { drive_folder_id: 'P-folder', gdrive_folder_url: null }; links(['a1'])
    const { ensureContactFolder } = await import('@/lib/drive-folder-utils')
    expect((await ensureContactFolder('c4', 'Legacy Person')).folderId).toBe('P-folder')
    expect(st.driveWrites).toEqual([]); expect(st.openedPersonStorage).toEqual([])
  })
  it("the older link form is honoured: a person with only gdrive_folder_url still gets that folder", async () => {
    acct('Offboarding', 'F-rebis'); st.rows.contacts = { drive_folder_id: null, gdrive_folder_url: 'https://drive.google.com/drive/folders/P-url' }; links(['a1'])
    const { ensureContactFolder } = await import('@/lib/drive-folder-utils')
    expect((await ensureContactFolder('c5', 'Url Person')).folderId).toBe('P-url')
  })
})
void FIVE
