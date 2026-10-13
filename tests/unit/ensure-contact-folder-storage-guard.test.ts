import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: { from: vi.fn() } }))
const createFolder = vi.fn()
vi.mock('@/lib/google-drive', () => ({ createFolder: (...a: unknown[]) => createFolder(...a), listFolderAnyDrive: vi.fn(), moveFile: vi.fn() }))
vi.mock('@/lib/crm-store/person-drive-guard', async () => {
  const real = await vi.importActual<typeof import('@/lib/crm-store/person-drive-guard')>('@/lib/crm-store/person-drive-guard')
  return { ...real, assertPersonFilesStillOnDrive: vi.fn(async () => { throw new real.PersonFilesInStorageError() }) }
})

describe('ensureContactFolder for a person whose files are in the new storage', () => {
  it('refuses before touching Drive', async () => {
    const { ensureContactFolder } = await import('@/lib/drive-folder-utils')
    await expect(ensureContactFolder('c1', 'Someone')).rejects.toThrow(/new storage/)
    expect(createFolder).not.toHaveBeenCalled()
  })
})
