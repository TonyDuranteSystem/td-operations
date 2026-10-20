/**
 * saveFormToDrive bucket-override regression test (2026-06-10), kept on the storage route after Stop Drive S2.
 *
 * Bug: portal tax submissions had 0 attachments copied and no P&L/Balance Sheet. Root cause — the portal wizard uploads files to the
 * shared "onboarding-uploads" bucket, but saveFormToDrive("tax_return") defaulted to the external tax form's "tax-form-uploads" bucket,
 * so every download failed. The fix adds an opts.bucket override. These tests lock in:
 *   1. opts.bucket overrides the per-form-type config default.
 *   2. Omitting opts.bucket still uses the config default (external form path).
 * Stop Drive S2: the files are filed in the company's STORAGE (the bucket decides where the upload is READ from); Google Drive is never touched.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const saved: Array<{ bucketOf: (p: string) => string }> = []
const driveCalls: string[] = []

vi.mock('@/lib/crm-store/save-form', () => ({
  switchedTargetForFolder: vi.fn(async () => ({ kind: 'account', id: 'acct-1', ownerId: 'owner-1' })),
  saveFormToStore: vi.fn(async (spec: { bucketOf: (p: string) => string }) => {
    saved.push(spec)
    return { summaryFileId: 'store:s', copied: [], failed: [], skipped: [], errors: [] }
  }),
  parseStorageMarker: () => null,
}))
vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: { storage: { from: () => ({}) } } }))
vi.mock('@/lib/crm-store/switched-drive-guard', () => ({
  personFilesInStorage: async () => false,
  liveOwnerOfContact: async () => null,
  liveOwnerOfAccount: async () => 'owner-1',
  companyDocState: async () => 'store',
}))
// Drive must never be called: every function records and throws.
vi.mock('@/lib/google-drive', () => new Proxy({}, { get: (_t, name) => (name === 'then' ? undefined : async () => { driveCalls.push(String(name)); throw new Error(`Drive must not be called: ${String(name)}`) }) }))

import { saveFormToDrive } from '@/lib/form-to-drive'

beforeEach(() => {
  saved.length = 0
  driveCalls.length = 0
})

const META = { token: 'portal-test-2025', submittedAt: '2026-06-10T00:00:00Z', companyName: 'Test LLC', year: 2025 }

describe('saveFormToDrive bucket override (storage route)', () => {
  it('reads uploads from opts.bucket when provided (portal wizard path)', async () => {
    await saveFormToDrive('tax_return', { llc_name: 'Test LLC' }, ['tax/acct-uuid/bank_statements_abc_relay.pdf'], 'root-folder', META, { bucket: 'onboarding-uploads' })
    expect(saved[0].bucketOf('tax/acct-uuid/bank_statements_abc_relay.pdf')).toBe('onboarding-uploads')
    expect(driveCalls).toEqual([])
  })

  it('falls back to the config default bucket when no override (external form path)', async () => {
    await saveFormToDrive('tax_return', { llc_name: 'Test LLC' }, ['test-llc-2025/bank_statement_0_wise.pdf'], 'root-folder', META)
    expect(saved[0].bucketOf('test-llc-2025/bank_statement_0_wise.pdf')).toBe('tax-form-uploads')
    expect(driveCalls).toEqual([])
  })
})

describe('saveFormToDrive — a real Google Drive folder is never written (Stop Drive S2)', () => {
  it('a destination that no storage owns gets an error result, zero Drive calls', async () => {
    const { switchedTargetForFolder } = await import('@/lib/crm-store/save-form')
    vi.mocked(switchedTargetForFolder).mockResolvedValueOnce(null)
    const r = await saveFormToDrive('tax_return', { llc_name: 'Test LLC' }, ['x/y.pdf'], 'some-real-drive-folder', META)
    expect(r.summaryFileId).toBeNull()
    expect(r.copied).toEqual([])
    expect(r.errors[0]).toMatch(/no document storage/)
    expect(driveCalls).toEqual([])
  })
})
