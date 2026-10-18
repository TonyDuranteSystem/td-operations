import { describe, it, expect, vi } from 'vitest'
import { companyStoragePlace, personStoragePlace, type StoragePlaceDeps } from '@/lib/crm-store/storage-place'

const deps = (over: Partial<StoragePlaceDeps> = {}): StoragePlaceDeps => ({
  companyState: vi.fn(async () => 'switched'),
  liveOwnerOfContact: vi.fn(async () => null),
  ensurePersonOwner: vi.fn(async () => 'owner-1'),
  ...over,
})

describe('companyStoragePlace', () => {
  it('ok for a company whose files live in the storage', async () => {
    expect(await companyStoragePlace('a1', deps())).toEqual({ ok: true, message: '' })
  })
  it('refuses a company still on the old Drive (REBIS / YBR / Degasper / Fresh Legal shape) in one plain sentence', async () => {
    const r = await companyStoragePlace('a1', deps({ companyState: async () => 'drive' }))
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/no storage place yet/i); expect(r.message).not.toMatch(/drive/i)
  })
  it('asks to wait while the company is being moved', async () => {
    const r = await companyStoragePlace('a1', deps({ companyState: async () => 'moving' }))
    expect(r.ok).toBe(false)
  })
  it('refuses when there is no company at all', async () => {
    expect((await companyStoragePlace(null, deps())).ok).toBe(false)
  })
})

describe('personStoragePlace', () => {
  it('ok without creating anything when the person already has storage', async () => {
    const d = deps({ liveOwnerOfContact: async () => 'o1' })
    expect(await personStoragePlace('c1', 'Ann', d)).toEqual({ ok: true, message: '' })
    expect(d.ensurePersonOwner).not.toHaveBeenCalled()
  })
  it('creates the person storage when they have none but exist as a contact', async () => {
    const d = deps()
    expect(await personStoragePlace('c1', 'Ann', d)).toEqual({ ok: true, message: '' })
    expect(d.ensurePersonOwner).toHaveBeenCalledWith('c1', 'Ann')
  })
  it('refuses a form that is not linked to a person (no contact), creating nothing', async () => {
    const d = deps()
    const r = await personStoragePlace(null, 'Ann', d)
    expect(r.ok).toBe(false)
    expect(d.ensurePersonOwner).not.toHaveBeenCalled()
  })
})
