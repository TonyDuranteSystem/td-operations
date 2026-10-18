import { describe, it, expect, vi } from 'vitest'
import { decideLegacyAccount, legacyDriveForAccount, legacyDriveForContact, raiseDriveWriteRefused, LEGACY_REFUSAL_SENTENCE, DriveWriteRefusedError } from '@/lib/crm-store/legacy-drive'

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

describe('legacyDriveForContact', () => {
  const ok = { allowed: true as const, folderId: 'acc-folder' }
  const no = { allowed: false as const, reason: 'archived' as const, sentence: 'x' }
  const mk = (f: { liveOwner: boolean; driveFolderId: string | null; accountIds: string[] }, accounts: Record<string, typeof ok | typeof no>) =>
    ({ load: async () => f, account: async (id: string) => accounts[id] ?? no })
  it('own folder + no storage + belongs to a legacy company -> allowed with the PERSON\'S folder', async () => {
    expect(await legacyDriveForContact('c', mk({ liveOwner: false, driveFolderId: 'p-folder', accountIds: ['a1', 'a2'] }, { a2: ok }))).toEqual({ allowed: true, folderId: 'p-folder' })
  })
  it('a person with their own storage is never written to in Drive', async () => {
    expect(await legacyDriveForContact('c', mk({ liveOwner: true, driveFolderId: 'p', accountIds: ['a1'] }, { a1: ok }))).toMatchObject({ allowed: false, reason: 'has_storage' })
  })
  it('a lead / person with no folder and no company gets no Drive folder', async () => {
    expect(await legacyDriveForContact('c', mk({ liveOwner: false, driveFolderId: null, accountIds: [] }, {}))).toMatchObject({ allowed: false, reason: 'no_folder' })
    expect(await legacyDriveForContact('c', mk({ liveOwner: false, driveFolderId: 'p', accountIds: [] }, {}))).toMatchObject({ allowed: false, reason: 'no_company' })
  })
  it('a person only of closed / in-storage companies is refused', async () => {
    expect(await legacyDriveForContact('c', mk({ liveOwner: false, driveFolderId: 'p', accountIds: ['a1'] }, { a1: no }))).toMatchObject({ allowed: false })
  })
})

describe('refusal reporting', () => {
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
  it('DriveWriteRefusedError carries the reason and the sentence', () => {
    const e = new DriveWriteRefusedError('archived')
    expect(e.name).toBe('DriveWriteRefusedError')
    expect(e.message).toBe(LEGACY_REFUSAL_SENTENCE.archived)
    expect(raiseDriveWriteRefused).toBeTypeOf('function')
  })
})
