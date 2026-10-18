import { describe, it, expect, vi, beforeEach } from 'vitest'
import { isArchivedStatus, folderIdOfRecord, forgetRecentAlarms, ALARM_THROTTLE_MS, decideLegacyAccount, legacyDriveForAccount, legacyDriveForContact, raiseDriveWriteRefused, LEGACY_REFUSAL_SENTENCE, LegacyDriveRefusedError } from '@/lib/crm-store/legacy-drive'

// Stop Drive S1d: the ONE definition of the companies / people that may still be written to in Google Drive.
describe('decideLegacyAccount', () => {
  const base = { status: 'Offboarding', driveFolderId: 'f1', state: 'drive' as const }
  it('folder + no storage + not closed -> allowed (REBIS / YBR / Degasper / Fresh Legal shape)', () => {
    for (const status of ['Offboarding', 'Suspended', 'Active', 'Pending Formation']) {
      expect(decideLegacyAccount({ ...base, status })).toEqual({ allowed: true, folderId: 'f1' })
    }
  })
  it('a company in storage is never written to', () => expect(decideLegacyAccount({ ...base, state: 'store' })).toMatchObject({ allowed: false, reason: 'has_storage' }))
  it('a company mid-move is refused (move in progress)', () => expect(decideLegacyAccount({ ...base, state: 'moving' })).toMatchObject({ allowed: false, reason: 'moving' }))
  it('Closed and Cancelled are a read-only archive', () => {
    for (const status of ['Closed', 'Cancelled']) expect(decideLegacyAccount({ ...base, status })).toMatchObject({ allowed: false, reason: 'archived' })
  })
  it('storage wins over archive wording; no folder -> nothing to write into', () => {
    expect(decideLegacyAccount({ ...base, driveFolderId: null })).toMatchObject({ allowed: false, reason: 'no_folder' })
    expect(decideLegacyAccount({ ...base, state: 'store', status: 'Closed' })).toMatchObject({ reason: 'has_storage' })
  })
  it('unknown account', () => {
    expect(decideLegacyAccount(null)).toMatchObject({ allowed: false, reason: 'no_company' })
    expect(decideLegacyAccount({ status: null, driveFolderId: 'f', state: 'drive' })).toMatchObject({ reason: 'no_company' })
  })
  it('every refusal has a plain sentence with no technical words', () => {
    for (const s of Object.values(LEGACY_REFUSAL_SENTENCE)) expect(s).toMatch(/^[A-Z].*[.]$/)
  })
})

describe('legacyDriveForAccount (injected facts)', () => {
  it('no id -> no_company without a lookup', async () => {
    const load = vi.fn()
    expect(await legacyDriveForAccount(null, { load })).toMatchObject({ allowed: false, reason: 'no_company' })
    expect(load).not.toHaveBeenCalled()
  })
  it('a read error is never turned into permission (fails closed)', async () => {
    await expect(legacyDriveForAccount('a', { load: async () => { throw new Error('db down') } })).rejects.toThrow('db down')
  })
})

describe('status and folder helpers — one definition', () => {
  it('Closed / Cancelled in any letter case, with spaces', () => {
    for (const s of ['Closed', 'closed', ' CANCELLED ', 'cancelled']) expect(isArchivedStatus(s)).toBe(true)
    for (const s of ['Active', 'Offboarding', 'Suspended', 'Pending Formation', '', null, undefined]) expect(isArchivedStatus(s as string)).toBe(false)
  })
  it('a lower-case "closed" account is still archive', () => {
    expect(decideLegacyAccount({ status: 'closed', driveFolderId: 'f', state: 'drive' })).toMatchObject({ allowed: false, reason: 'archived' })
  })
  it('the folder id comes from drive_folder_id, else from the older link', () => {
    expect(folderIdOfRecord({ drive_folder_id: 'A', gdrive_folder_url: 'https://drive.google.com/drive/folders/B' })).toBe('A')
    expect(folderIdOfRecord({ drive_folder_id: null, gdrive_folder_url: 'https://drive.google.com/drive/folders/B_-1?usp=x' })).toBe('B_-1')
    expect(folderIdOfRecord({ drive_folder_id: null, gdrive_folder_url: null })).toBeNull()
    expect(folderIdOfRecord(null)).toBeNull()
  })
})

describe('legacyDriveForContact', () => {
  const ok = { allowed: true as const, folderId: 'acc-folder' }
  const no = (reason: 'archived' | 'has_storage' | 'moving' | 'no_folder') => ({ allowed: false as const, reason, sentence: 'x' })
  const mk = (f: { liveOwner: boolean; driveFolderId: string | null; accountIds: string[] }, accounts: Record<string, ReturnType<typeof no> | typeof ok>) =>
    ({ load: async () => f, account: async (id: string) => accounts[id] ?? no('archived') })
  it("own folder + no storage + belongs to a legacy company -> allowed with the PERSON'S folder", async () => {
    expect(await legacyDriveForContact('c', mk({ liveOwner: false, driveFolderId: 'p-folder', accountIds: ['a1', 'a2'] }, { a1: no('archived'), a2: ok }))).toEqual({ allowed: true, folderId: 'p-folder' })
  })
  it("a person of a left-on-Drive company who never had a folder uses the COMPANY's folder (one person's papers are never split)", async () => {
    expect(await legacyDriveForContact('c', mk({ liveOwner: false, driveFolderId: null, accountIds: ['a2'] }, { a2: ok }))).toEqual({ allowed: true, folderId: 'acc-folder' })
  })
  it('a person with their own storage is never written to in Drive', async () => {
    expect(await legacyDriveForContact('c', mk({ liveOwner: true, driveFolderId: 'p', accountIds: ['a1'] }, { a1: ok }))).toMatchObject({ allowed: false, reason: 'has_storage' })
  })
  it('a lead with no company: no Drive folder, the true reason', async () => {
    expect(await legacyDriveForContact('c', mk({ liveOwner: false, driveFolderId: null, accountIds: [] }, {}))).toMatchObject({ allowed: false, reason: 'no_folder' })
    expect(await legacyDriveForContact('c', mk({ liveOwner: false, driveFolderId: 'p', accountIds: [] }, {}))).toMatchObject({ allowed: false, reason: 'no_company' })
  })
  it('the refusal names the TRUE reason: companies in storage -> has_storage (not "closed"); moving -> moving; closed -> archived', async () => {
    expect(await legacyDriveForContact('c', mk({ liveOwner: false, driveFolderId: 'p', accountIds: ['a1'] }, { a1: no('has_storage') }))).toMatchObject({ reason: 'has_storage' })
    expect(await legacyDriveForContact('c', mk({ liveOwner: false, driveFolderId: 'p', accountIds: ['a1', 'a2'] }, { a1: no('archived'), a2: no('has_storage') }))).toMatchObject({ reason: 'has_storage' })
    expect(await legacyDriveForContact('c', mk({ liveOwner: false, driveFolderId: 'p', accountIds: ['a1'] }, { a1: no('moving') }))).toMatchObject({ reason: 'moving' })
    expect(await legacyDriveForContact('c', mk({ liveOwner: false, driveFolderId: 'p', accountIds: ['a1'] }, { a1: no('archived') }))).toMatchObject({ reason: 'archived' })
  })
})

describe('refusal reporting', () => {
  beforeEach(() => forgetRecentAlarms())
  it('raiseDriveWriteRefused returns the plain sentence and never throws, even if the alarm itself fails', async () => {
    vi.resetModules()
    vi.doMock('@/lib/crm-store/formation-pilot', () => ({ raisePilotAlarm: async () => { throw new Error('alarm down') } }))
    const m = await import('@/lib/crm-store/legacy-drive')
    await expect(m.raiseDriveWriteRefused({ flow: 'x', accountId: 'a', reason: 'archived' })).resolves.toBe(LEGACY_REFUSAL_SENTENCE.archived)
    vi.doUnmock('@/lib/crm-store/formation-pilot')
  })
  it('the alarm carries the flow, the company and the reason', async () => {
    vi.resetModules()
    const raise = vi.fn(async () => {})
    vi.doMock('@/lib/crm-store/formation-pilot', () => ({ raisePilotAlarm: raise }))
    const m = await import('@/lib/crm-store/legacy-drive')
    await m.raiseDriveWriteRefused({ flow: 'lease-signed', accountId: 'a1', reason: 'has_storage', detail: 'lease 9' })
    expect(raise).toHaveBeenCalledWith('drive_write_refused', { flow: 'lease-signed', accountId: 'a1', contactId: null, reason: 'has_storage', detail: 'lease 9' })
    vi.doUnmock('@/lib/crm-store/formation-pilot')
  })
  it('LegacyDriveRefusedError carries the reason and the sentence', () => {
    const e = new LegacyDriveRefusedError('archived')
    expect(e.name).toBe('LegacyDriveRefusedError')
    expect(e.message).toBe(LEGACY_REFUSAL_SENTENCE.archived)
    expect(raiseDriveWriteRefused).toBeTypeOf('function')
  })
})

describe('alarm throttle — a retrying job cannot spam staff', () => {
  beforeEach(() => forgetRecentAlarms())
  it('the same refusal alarms once per window, a different reason / company alarms again', async () => {
    vi.resetModules()
    const raise = vi.fn(async () => {})
    vi.doMock('@/lib/crm-store/formation-pilot', () => ({ raisePilotAlarm: raise }))
    vi.doMock('@/lib/supabase-admin', () => ({ supabaseAdmin: { from: () => { const c: Record<string, unknown> = {}; for (const m of ['select', 'eq', 'gte', 'contains', 'limit']) c[m] = () => c; c.then = (r: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(r); return c } } }))
    const m = await import('@/lib/crm-store/legacy-drive')
    m.forgetRecentAlarms()
    const t0 = 1_000_000
    for (let i = 0; i < 5; i++) await m.raiseDriveWriteRefused({ flow: 'x', accountId: 'a', reason: 'archived' }, t0 + i * 1000)
    expect(raise).toHaveBeenCalledTimes(1)
    await m.raiseDriveWriteRefused({ flow: 'x', accountId: 'a', reason: 'no_folder' }, t0 + 6000)
    await m.raiseDriveWriteRefused({ flow: 'x', accountId: 'b', reason: 'archived' }, t0 + 7000)
    expect(raise).toHaveBeenCalledTimes(3)
    await m.raiseDriveWriteRefused({ flow: 'x', accountId: 'a', reason: 'archived' }, t0 + ALARM_THROTTLE_MS + 10_000)
    expect(raise).toHaveBeenCalledTimes(4)
    vi.doUnmock('@/lib/crm-store/formation-pilot'); vi.doUnmock('@/lib/supabase-admin')
  })
  it('another server instance that already alarmed (found in the store history) keeps this one quiet', async () => {
    vi.resetModules()
    const raise = vi.fn(async () => {})
    vi.doMock('@/lib/crm-store/formation-pilot', () => ({ raisePilotAlarm: raise }))
    vi.doMock('@/lib/supabase-admin', () => ({ supabaseAdmin: { from: () => { const c: Record<string, unknown> = {}; for (const m of ['select', 'eq', 'gte', 'contains', 'limit']) c[m] = () => c; c.then = (r: (v: unknown) => unknown) => Promise.resolve({ data: [{ id: 1 }], error: null }).then(r); return c } } }))
    const m = await import('@/lib/crm-store/legacy-drive')
    m.forgetRecentAlarms()
    await m.raiseDriveWriteRefused({ flow: 'x', accountId: 'a', reason: 'archived' })
    expect(raise).not.toHaveBeenCalled()
    vi.doUnmock('@/lib/crm-store/formation-pilot'); vi.doUnmock('@/lib/supabase-admin')
  })
})
