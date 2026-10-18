import { describe, it, expect, vi, beforeEach } from 'vitest'

// Stop Drive (dev job 264bb882, slice S1d): ensureCompanyFolder / ensureContactFolder NEVER create a Drive folder.
// Drive is a SPY that fails on any write: the only allowed Drive traffic is listing the folder a legacy company already has.
const driveWrites = vi.hoisted(() => ({ createFolder: vi.fn(), moveFile: vi.fn(), listFolderAnyDrive: vi.fn() }))
vi.mock('@/lib/google-drive', () => ({
  createFolder: (...a: unknown[]) => { driveWrites.createFolder(...a); throw new Error('DRIVE WRITE: createFolder') },
  moveFile: (...a: unknown[]) => { driveWrites.moveFile(...a); throw new Error('DRIVE WRITE: moveFile') },
  listFolderAnyDrive: (...a: unknown[]) => driveWrites.listFolderAnyDrive(...a),
}))
vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: { from: vi.fn() } }))
vi.mock('@/lib/crm-store/browse', () => ({ assertNotStoreOwnedAccount: vi.fn(async () => {}) }))
vi.mock('@/lib/crm-store/person-drive-guard', () => ({ assertPersonFilesStillOnDrive: vi.fn(async () => {}) }))
const verdicts = vi.hoisted(() => ({ account: null as unknown, contact: null as unknown, alarms: [] as unknown[] }))
vi.mock('@/lib/crm-store/legacy-drive', async () => {
  const real = await vi.importActual<typeof import('@/lib/crm-store/legacy-drive')>('@/lib/crm-store/legacy-drive')
  return {
    ...real,
    legacyDriveForAccount: vi.fn(async () => verdicts.account),
    legacyDriveForContact: vi.fn(async () => verdicts.contact),
    raiseDriveWriteRefused: vi.fn(async (p: { reason: keyof typeof real.LEGACY_REFUSAL_SENTENCE }) => { verdicts.alarms.push(p); return real.LEGACY_REFUSAL_SENTENCE[p.reason] }),
  }
})

import { supabaseAdmin } from '@/lib/supabase-admin'

function chain(data: unknown) {
  const r = { data, error: null }
  const c: Record<string, unknown> = { then: (res: (v: typeof r) => unknown) => Promise.resolve(r).then(res) }
  for (const m of ['select', 'eq', 'not', 'limit', 'update']) c[m] = vi.fn(() => c)
  c.single = vi.fn(() => Promise.resolve(r))
  c.maybeSingle = vi.fn(() => Promise.resolve(r))
  return c
}
const refused = (reason: string) => ({ allowed: false as const, reason, sentence: 'x' })

beforeEach(() => {
  vi.clearAllMocks()
  verdicts.alarms.length = 0
  vi.mocked(supabaseAdmin.from).mockImplementation(((table: string) => {
    if (table === 'service_deliveries') return chain(null)
    throw new Error(`unexpected table ${table}`)
  }) as never)
})

describe('ensureCompanyFolder — never creates, only hands back a legacy company\'s existing folder', () => {
  it.each(['has_storage', 'moving', 'archived', 'no_folder', 'no_company'])('refuses (%s) with an alarm and ZERO Drive calls', async (reason) => {
    verdicts.account = refused(reason)
    const { ensureCompanyFolder } = await import('@/lib/drive-folder-utils')
    await expect(ensureCompanyFolder('acc-1', 'Acme LLC', 'Wyoming', 'Jo')).rejects.toMatchObject({ name: 'DriveWriteRefusedError', reason })
    expect(driveWrites.createFolder).not.toHaveBeenCalled()
    expect(driveWrites.moveFile).not.toHaveBeenCalled()
    expect(driveWrites.listFolderAnyDrive).not.toHaveBeenCalled()
    expect(verdicts.alarms).toHaveLength(1)
    expect(verdicts.alarms[0]).toMatchObject({ flow: 'ensureCompanyFolder', accountId: 'acc-1', reason })
  })

  it('a legacy company (folder, no storage, not closed): returns its folder; nothing is created when all five subfolders exist', async () => {
    verdicts.account = { allowed: true, folderId: 'legacy-folder' }
    driveWrites.listFolderAnyDrive.mockResolvedValueOnce({ files: ['1. Company', '2. Contacts', '3. Tax', '4. Banking', '5. Correspondence'].map((n, i) => ({ id: `s${i}`, name: n, mimeType: 'application/vnd.google-apps.folder' })) })
    const { ensureCompanyFolder } = await import('@/lib/drive-folder-utils')
    const r = await ensureCompanyFolder('acc-2', 'REBIS', 'Delaware')
    expect(r).toMatchObject({ folderId: 'legacy-folder', created: false })
    expect(driveWrites.createFolder).not.toHaveBeenCalled()
    expect(verdicts.alarms).toHaveLength(0)
  })
})

describe('ensureContactFolder — never creates a Contacts/<name> folder', () => {
  it.each(['has_storage', 'archived', 'no_folder', 'no_company'])('a person that is not a legacy one (%s): refused with an alarm, zero Drive calls', async (reason) => {
    verdicts.contact = refused(reason)
    const { ensureContactFolder } = await import('@/lib/drive-folder-utils')
    await expect(ensureContactFolder('c-1', 'Maria Verdi')).rejects.toMatchObject({ name: 'DriveWriteRefusedError', reason })
    expect(driveWrites.createFolder).not.toHaveBeenCalled()
    expect(driveWrites.listFolderAnyDrive).not.toHaveBeenCalled()
    expect(verdicts.alarms[0]).toMatchObject({ flow: 'ensureContactFolder', contactId: 'c-1', reason })
  })

  it('a person whose materialized company is in storage/closed is refused too (the company folder is not handed back)', async () => {
    vi.mocked(supabaseAdmin.from).mockImplementation(((table: string) => {
      if (table === 'service_deliveries') return chain({ account_id: 'acc-9' })
      throw new Error(`unexpected table ${table}`)
    }) as never)
    verdicts.account = refused('archived')
    const { ensureContactFolder } = await import('@/lib/drive-folder-utils')
    await expect(ensureContactFolder('c-2', 'Someone')).rejects.toMatchObject({ reason: 'archived' })
    expect(driveWrites.listFolderAnyDrive).not.toHaveBeenCalled()
  })

  it('a legacy person: returns the folder they already have', async () => {
    verdicts.contact = { allowed: true, folderId: 'person-folder' }
    driveWrites.listFolderAnyDrive.mockResolvedValueOnce({ files: ['1. Company', '2. Contacts', '3. Tax', '4. Banking', '5. Correspondence'].map((n, i) => ({ id: `s${i}`, name: n, mimeType: 'application/vnd.google-apps.folder' })) })
    const { ensureContactFolder } = await import('@/lib/drive-folder-utils')
    expect((await ensureContactFolder('c-3', 'Legacy Person')).folderId).toBe('person-folder')
    expect(driveWrites.createFolder).not.toHaveBeenCalled()
  })
})
