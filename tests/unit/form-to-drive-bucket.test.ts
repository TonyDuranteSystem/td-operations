/**
 * saveFormToDrive bucket-override regression test (2026-06-10).
 *
 * Bug: portal tax submissions had 0 attachments copied to Drive and no
 * P&L/Balance Sheet. Root cause — the portal wizard uploads files to the
 * shared "onboarding-uploads" bucket, but saveFormToDrive("tax_return")
 * defaulted to the external tax form's "tax-form-uploads" bucket, so every
 * download failed. The fix adds an opts.bucket override. These tests lock in:
 *   1. opts.bucket overrides the per-form-type config default.
 *   2. Omitting opts.bucket still uses the config default (external form path).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Capture every bucket passed to supabaseAdmin.storage.from(...)
let bucketsUsed: string[] = []

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    storage: {
      from: (bucket: string) => {
        bucketsUsed.push(bucket)
        return {
          download: vi.fn(async () => ({
            data: {
              size: 4,
              type: 'application/pdf',
              arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
            },
            error: null,
          })),
        }
      },
    },
  },
}))

// Drive is fully stubbed — folders "exist" so no create calls, uploads no-op.
vi.mock('@/lib/google-drive', () => ({
  listFolder: vi.fn(async () => ({ files: [] })),
  createFolder: vi.fn(async (_parent: string, name: string) => ({ id: `folder-${name}` })),
  uploadBinaryToDrive: vi.fn(async () => ({ id: 'drive-file-id' })),
  uploadBinaryToDriveUpsert: vi.fn(async () => ({ id: 'drive-file-id', name: 'f', action: 'created' })),
  folderFileNameMap: vi.fn(async () => new Map()),
}))

import { saveFormToDrive } from '@/lib/form-to-drive'

beforeEach(() => {
  bucketsUsed = []
})

const META = { token: 'portal-test-2025', submittedAt: '2026-06-10T00:00:00Z', companyName: 'Test LLC', year: 2025 }

describe('saveFormToDrive bucket override', () => {
  it('downloads uploads from opts.bucket when provided (portal wizard path)', async () => {
    await saveFormToDrive(
      'tax_return',
      { llc_name: 'Test LLC' },
      ['tax/acct-uuid/bank_statements_abc_relay.pdf'],
      'root-folder',
      META,
      { bucket: 'onboarding-uploads' },
    )
    // The only storage.from() call comes from the upload-copy phase.
    expect(bucketsUsed).toContain('onboarding-uploads')
    expect(bucketsUsed).not.toContain('tax-form-uploads')
  })

  it('falls back to the config default bucket when no override (external form path)', async () => {
    await saveFormToDrive(
      'tax_return',
      { llc_name: 'Test LLC' },
      ['test-llc-2025/bank_statement_0_wise.pdf'],
      'root-folder',
      META,
    )
    expect(bucketsUsed).toContain('tax-form-uploads')
    expect(bucketsUsed).not.toContain('onboarding-uploads')
  })
})
