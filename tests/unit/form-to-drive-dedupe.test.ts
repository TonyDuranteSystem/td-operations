/**
 * Drive duplicate-upload guard (LT Program incidents, 2026-06-16 + 2026-07-07):
 * re-running a form save must not pile duplicate copies into the folder.
 *
 * Locks in:
 *   1. copyUploadsToDrive skips file names already present in the folder.
 *   2. copyUploadsToDrive still uploads names NOT present.
 *   3. A failed folder listing (null map) falls back to uploading everything —
 *      stray duplicate beats silently missing file.
 *   4. saveFormToDrive upserts the summary PDF (stable name → overwrite, not
 *      a new copy).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    storage: {
      from: () => ({
        download: vi.fn(async () => ({
          data: {
            size: 4,
            type: 'application/pdf',
            arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
          },
          error: null,
        })),
      }),
    },
  },
}))

const uploadCalls: string[] = []
const upsertCalls: { name: string; hadExisting: boolean }[] = []
let nameMapResult: Map<string, string> | null = new Map()

vi.mock('@/lib/google-drive', () => ({
  listFolder: vi.fn(async () => ({ files: [{ id: 'sub-1', name: '3. Tax', mimeType: 'application/vnd.google-apps.folder' }] })),
  createFolder: vi.fn(async (_parent: string, name: string) => ({ id: `folder-${name}` })),
  folderFileNameMap: vi.fn(async () => nameMapResult),
  uploadBinaryToDrive: vi.fn(async (fileName: string) => {
    uploadCalls.push(fileName)
    return { id: `drive-${fileName}` }
  }),
  uploadBinaryToDriveUpsert: vi.fn(async (fileName: string, _d: Buffer, _m: string, _p: string, existing?: Map<string, string> | null) => {
    upsertCalls.push({ name: fileName, hadExisting: !!existing?.has(fileName) })
    return { id: `drive-${fileName}`, name: fileName, action: existing?.has(fileName) ? 'overwritten' : 'created' }
  }),
}))

import { copyUploadsToDrive, saveFormToDrive } from '@/lib/form-to-drive'

beforeEach(() => {
  vi.clearAllMocks()
  uploadCalls.length = 0
  upsertCalls.length = 0
  nameMapResult = new Map()
})

describe('copyUploadsToDrive duplicate guard', () => {
  it('skips names already on Drive, uploads the rest', async () => {
    nameMapResult = new Map([['statement_abc_mercury.csv', 'existing-id']])
    const res = await copyUploadsToDrive(
      ['tax/acct/statement_abc_mercury.csv', 'tax/acct/statement_def_wise.csv'],
      'onboarding-uploads',
      'folder-x'
    )
    expect(res.skipped).toEqual(['statement_abc_mercury.csv'])
    expect(res.copied).toEqual(['statement_def_wise.csv'])
    expect(uploadCalls).toEqual(['statement_def_wise.csv'])
    expect(res.failed).toEqual([])
  })

  it('uploads everything when the folder listing failed (null map)', async () => {
    nameMapResult = null
    const res = await copyUploadsToDrive(
      ['tax/acct/statement_abc_mercury.csv'],
      'onboarding-uploads',
      'folder-x'
    )
    expect(res.copied).toEqual(['statement_abc_mercury.csv'])
    expect(res.skipped).toEqual([])
  })

  it('uses a pre-fetched name map without re-listing', async () => {
    const { folderFileNameMap } = await import('@/lib/google-drive')
    const pre = new Map([['doc_a.pdf', 'id-a']])
    const res = await copyUploadsToDrive(['up/doc_a.pdf'], 'b', 'folder-x', undefined, { existingNames: pre })
    expect(res.skipped).toEqual(['doc_a.pdf'])
    expect(vi.mocked(folderFileNameMap)).not.toHaveBeenCalled()
  })
})

describe('saveFormToDrive summary PDF upsert', () => {
  it('routes the summary PDF through the upsert helper (stable name, no copies)', async () => {
    await saveFormToDrive(
      'tax_return',
      { llc_name: 'Test LLC' },
      [],
      'root-folder',
      { token: 'tok', submittedAt: '2026-07-07T00:00:00Z', companyName: 'Test LLC', year: 2025 }
    )
    expect(upsertCalls.length).toBe(1)
    expect(upsertCalls[0].name).toMatch(/^Tax_Data_Test_LLC\.pdf$/)
  })
})
