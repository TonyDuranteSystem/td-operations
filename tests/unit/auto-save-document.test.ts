/**
 * Phase B (ITIN Chain Fix 2026-05-11) — autoSaveDocument unit tests.
 *
 * The PR #59 deferral: pure contact-only ITINs (no account_id) couldn't
 * register portal documents because autoSaveDocument required accountId.
 * Phase B extends it to accept contactId so the /portal/itin-documents
 * page can show the generated PDFs to those clients.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
}))

interface InsertCapture {
  account_id: unknown
  contact_id: unknown
  file_name: unknown
  document_type_name: unknown
  category: unknown
  portal_visible: unknown
}

let insertCapture: InsertCapture | null = null
let driveLookupResult: { id: string } | null = null

vi.mock('@/lib/supabase-admin', () => {
  return {
    supabaseAdmin: {
      from: (table: string) => {
        if (table !== 'documents') throw new Error(`unexpected table ${table}`)
        return {
          // Idempotency lookup chain.
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          limit: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn(() => Promise.resolve({ data: driveLookupResult, error: null })),
          // Insert chain.
          insert: vi.fn((payload: InsertCapture) => {
            insertCapture = payload
            return {
              select: vi.fn().mockReturnThis(),
              single: vi.fn(() => Promise.resolve({ data: { id: 'new-doc-id' }, error: null })),
            }
          }),
        }
      },
    },
  }
})

import { autoSaveDocument } from '@/lib/portal/auto-save-document'

beforeEach(() => {
  insertCapture = null
  driveLookupResult = null
})

describe('autoSaveDocument — Phase B contact-only support', () => {
  it('inserts with account_id when accountId is provided', async () => {
    const result = await autoSaveDocument({
      accountId: 'acct-1',
      fileName: 'W-7.pdf',
      documentType: 'ITIN W-7',
      category: 3,
      portalVisible: true,
    })

    expect(result.id).toBe('new-doc-id')
    expect(insertCapture).toMatchObject({
      account_id: 'acct-1',
      contact_id: null,
      file_name: 'W-7.pdf',
      portal_visible: true,
    })
  })

  it('inserts with contact_id only for contact-only ITIN clients', async () => {
    const result = await autoSaveDocument({
      contactId: 'contact-1',
      fileName: 'W-7.pdf',
      documentType: 'ITIN W-7',
      category: 3,
      portalVisible: true,
    })

    expect(result.id).toBe('new-doc-id')
    expect(insertCapture).toMatchObject({
      account_id: null,
      contact_id: 'contact-1',
      file_name: 'W-7.pdf',
      portal_visible: true,
    })
  })

  it('returns an error when neither accountId nor contactId is provided', async () => {
    const result = await autoSaveDocument({
      fileName: 'orphan.pdf',
      documentType: 'Stray',
      category: 5,
    })

    expect(result.error).toMatch(/requires accountId or contactId/)
    expect(insertCapture).toBeNull()
  })

  it('returns the existing document id when drive_file_id is already saved (idempotent)', async () => {
    driveLookupResult = { id: 'existing-doc' }

    const result = await autoSaveDocument({
      contactId: 'contact-1',
      fileName: 'W-7.pdf',
      documentType: 'ITIN W-7',
      category: 3,
      driveFileId: 'drive-abc',
    })

    expect(result.id).toBe('existing-doc')
    expect(insertCapture).toBeNull()
  })
})

describe('autoSaveDocument — drive_link (2026-07-07 "No link" fix)', () => {
  it('derives drive_link from a real Drive file id', async () => {
    await autoSaveDocument({
      accountId: 'acct-1',
      fileName: 'Lease.pdf',
      documentType: 'Lease Agreement',
      category: 1,
      driveFileId: '1AbCdEfGh',
    })

    expect((insertCapture as unknown as { drive_link: string }).drive_link)
      .toBe('https://drive.google.com/file/d/1AbCdEfGh/view')
  })

  it('never fabricates a Drive URL for sentinel ids (storage:/ss4-live:)', async () => {
    for (const sentinel of ['storage:onboarding/x/y.pdf', 'ss4-live:ss4-token-2026']) {
      insertCapture = null
      await autoSaveDocument({
        accountId: 'acct-1',
        fileName: 'Doc.pdf',
        documentType: 'Form SS-4 (Signed)',
        category: 1,
        driveFileId: sentinel,
      })
      expect((insertCapture as unknown as { drive_link: unknown }).drive_link).toBeNull()
    }
  })

  it('leaves drive_link null when there is no drive file id', async () => {
    await autoSaveDocument({
      accountId: 'acct-1',
      fileName: 'Doc.pdf',
      documentType: 'Lease Agreement',
      category: 1,
    })
    expect((insertCapture as unknown as { drive_link: unknown }).drive_link).toBeNull()
  })
})
