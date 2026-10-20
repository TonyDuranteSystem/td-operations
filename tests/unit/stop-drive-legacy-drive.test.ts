import { describe, it, expect, vi, beforeEach } from 'vitest'
import { isArchivedStatus, folderIdOfRecord, forgetRecentAlarms, ALARM_THROTTLE_MS, decideLegacyAccount, legacyDriveForAccount, legacyDriveForContact, raiseDriveWriteRefused, LEGACY_REFUSAL_SENTENCE, LegacyDriveRefusedError } from '@/lib/crm-store/legacy-drive'

// Stop Drive S1d + S2: the ONE answer to "may this company / person be written to in Google Drive?" — since S2 it is always NO, with the true reason.
describe('decideLegacyAccount', () => {
  const base = { status: 'Offboarding', driveFolderId: 'f1', state: 'drive' as const }
  it('folder + no storage + not closed -> FROZEN, never allowed (REBIS / YBR / Degasper / Fresh Legal shape)', () => {
    for (const status of ['Offboarding', 'Suspended', 'Active', 'Pending Formation']) {
      expect(decideLegacyAccount({ ...base, status })).toMatchObject({ allowed: false, reason: 'frozen' })
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
  const ok = { allowed: false as const, reason: 'frozen' as const, sentence: 'x' }
  const no = (reason: 'archived' | 'has_storage' | 'moving' | 'no_folder' | 'frozen') => ({ allowed: false as const, reason, sentence: 'x' })
  const mk = (f: { liveOwner: boolean; driveFolderId: string | null; accountIds: string[] }, accounts: Record<string, ReturnType<typeof no> | typeof ok>) =>
    ({ load: async () => f, account: async (id: string) => accounts[id] ?? no('archived') })
  it("own folder + no storage + belongs to a company frozen on its old folder -> refused as 'frozen' (never a Drive write)", async () => {
    expect(await legacyDriveForContact('c', mk({ liveOwner: false, driveFolderId: 'p-folder', accountIds: ['a1', 'a2'] }, { a1: no('archived'), a2: ok }))).toMatchObject({ allowed: false, reason: 'frozen' })
  })
  it("a person of a company frozen on its old folder who never had a folder -> refused as 'frozen' too", async () => {
    expect(await legacyDriveForContact('c', mk({ liveOwner: false, driveFolderId: null, accountIds: ['a2'] }, { a2: ok }))).toMatchObject({ allowed: false, reason: 'frozen' })
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
  it('the alarm carries the flow, the company and the reason', async () => {
    const raise = vi.fn(async () => {})
    await raiseDriveWriteRefused({ flow: 'lease-signed', accountId: 'a1', reason: 'has_storage', detail: 'lease 9' }, Date.now(), { alreadyAlarmed: async () => false, raise })
    expect(raise).toHaveBeenCalledWith({ flow: 'lease-signed', accountId: 'a1', contactId: null, reason: 'has_storage', detail: 'lease 9' })
  })
  it('LegacyDriveRefusedError carries the reason and the sentence', () => {
    const e = new LegacyDriveRefusedError('archived')
    expect(e.name).toBe('LegacyDriveRefusedError')
    expect(e.message).toBe(LEGACY_REFUSAL_SENTENCE.archived)
  })
})

describe('alarm throttle — a retrying job cannot spam staff', () => {
  beforeEach(() => forgetRecentAlarms())
  it('the same refusal alarms once per window, a different reason / company alarms again', async () => {
    const raise = vi.fn(async () => {})
    const deps = { alreadyAlarmed: async () => false, raise }
    const t0 = 1_000_000
    for (let i = 0; i < 5; i++) await raiseDriveWriteRefused({ flow: 'x', accountId: 'a', reason: 'archived' }, t0 + i * 1000, deps)
    expect(raise).toHaveBeenCalledTimes(1)
    await raiseDriveWriteRefused({ flow: 'x', accountId: 'a', reason: 'no_folder' }, t0 + 6000, deps)
    await raiseDriveWriteRefused({ flow: 'x', accountId: 'b', reason: 'archived' }, t0 + 7000, deps)
    expect(raise).toHaveBeenCalledTimes(3)
    await raiseDriveWriteRefused({ flow: 'x', accountId: 'a', reason: 'archived' }, t0 + ALARM_THROTTLE_MS + 10_000, deps)
    expect(raise).toHaveBeenCalledTimes(4)
  })
  it('a refusal for a DIFFERENT file of the same company is a different problem and alarms again', async () => {
    const raise = vi.fn(async () => {})
    const deps = { alreadyAlarmed: async () => false, raise }
    await raiseDriveWriteRefused({ flow: 'x', accountId: 'a', reason: 'archived', detail: 'file-1.pdf' }, 1_000_000, deps)
    await raiseDriveWriteRefused({ flow: 'x', accountId: 'a', reason: 'archived', detail: 'file-2.pdf' }, 1_000_100, deps)
    await raiseDriveWriteRefused({ flow: 'x', accountId: 'a', reason: 'archived', detail: 'file-1.pdf' }, 1_000_200, deps)
    expect(raise).toHaveBeenCalledTimes(2)
  })
  it('a FAILED raise is not remembered: the next refusal tries again', async () => {
    let fail = true
    const raise = vi.fn(async () => { if (fail) throw new Error('down') })
    const deps = { alreadyAlarmed: async () => false, raise }
    await raiseDriveWriteRefused({ flow: 'z', accountId: 'a', reason: 'archived' }, 2_000_000, deps)
    fail = false
    await raiseDriveWriteRefused({ flow: 'z', accountId: 'a', reason: 'archived' }, 2_000_100, deps)
    await raiseDriveWriteRefused({ flow: 'z', accountId: 'a', reason: 'archived' }, 2_000_200, deps)
    expect(raise).toHaveBeenCalledTimes(2) // the failed one, then the one that went out; the third is quiet
  })
  it('another server instance that already alarmed (found in the store history) keeps this one quiet', async () => {
    const raise = vi.fn(async () => {})
    await raiseDriveWriteRefused({ flow: 'x', accountId: 'a', reason: 'archived' }, Date.now(), { alreadyAlarmed: async () => true, raise })
    expect(raise).not.toHaveBeenCalled()
  })
  it('a failing history lookup alarms anyway; a failing alarm never throws', async () => {
    const raise = vi.fn(async () => { throw new Error('alarm down') })
    await expect(raiseDriveWriteRefused({ flow: 'y', accountId: 'a', reason: 'archived' }, Date.now(), { alreadyAlarmed: async () => { throw new Error('db down') }, raise })).resolves.toBe(LEGACY_REFUSAL_SENTENCE.archived)
    expect(raise).toHaveBeenCalledTimes(1)
  })
})

describe('ONE rule: legacy-drive.ts agrees with no-storage.ts on every combination — and the answer is never "drive" (Stop Drive S2)', () => {
  const statuses = ['Active', 'Suspended', 'Offboarding', 'Pending Formation', 'Closed', 'closed', ' Cancelled ', 'CANCELED', '', null]
  const folders = [null, 'F1']
  it('a company is NEVER written to in Drive, and both rules give the same true reason', async () => {
    const { decideNoStorage } = await import('@/lib/crm-store/no-storage')
    for (const status of statuses) for (const folder of folders) {
      const mine = decideLegacyAccount({ status: status ?? '', driveFolderId: folder, state: 'drive' })
      const theirs = decideNoStorage({ status, drive_folder_id: folder })
      expect(mine.allowed, `${status}/${folder}`).toBe(false)
      expect(theirs.route, `${status}/${folder}`).toBe('refuse')
      if (status !== '' && status !== null) expect(mine.reason).toBe(theirs.reason)
    }
  })
  it('a person is NEVER written to in Drive either', async () => {
    const { decideNoStorageForContact, decideNoStorage } = await import('@/lib/crm-store/no-storage')
    const companyCases = [{ status: 'Offboarding', folder: 'F1' }, { status: 'Closed', folder: 'F1' }, { status: 'Active', folder: null }]
    for (const own of [null, 'P1']) for (const live of [false, true]) for (const c of companyCases) {
      const verdict = decideNoStorage({ status: c.status, drive_folder_id: c.folder })
      const theirs = decideNoStorageForContact({ liveOwner: live, folderId: own, companyVerdicts: [verdict], companyInStorageOrMoving: false })
      const mine = await legacyDriveForContact('c', {
        load: async () => ({ liveOwner: live, driveFolderId: own, accountIds: ['a'] }),
        account: async () => decideLegacyAccount({ status: c.status, driveFolderId: c.folder, state: 'drive' }),
      })
      expect(mine.allowed, JSON.stringify({ own, live, c })).toBe(false)
      expect(theirs.route, JSON.stringify({ own, live, c })).toBe('refuse')
    }
  })
})
