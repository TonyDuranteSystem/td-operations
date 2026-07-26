/**
 * Unit tests for saveSignedGeneratedDocument() in lib/portal/save-generated-document.ts
 *
 * Covers: no-Drive-folder error / happy path (Drive + canonical record + maker
 * pre-marked seen + co-owners alerted, maker NOT alerted) / single-owner (no
 * alerts) / kill-switch off / record-save failure returns the orphan drive id.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }))

// ─── Mock state ──────────────────────────────────────────
let accountRow: { drive_folder_id: string | null; company_name: string } | null = null
let autoSaveResult: { id?: string; error?: string } = { id: 'doc-1' }
let alertEnabled = true
let accountContactLinks: Array<{ contact_id: string }> = []
const contactLang: Record<string, string | null> = {}

const driveUploads: Array<{ fileName: string; folder: string }> = []
const autoSaveCalls: Array<Record<string, unknown>> = []
const docUpdates: Array<Record<string, unknown>> = []
const viewUpserts: Array<Record<string, unknown>> = []
const notifyCalls: Array<{ contact_id?: string; account_id?: string; title: string }> = []

vi.mock('@/lib/google-drive', () => ({
  uploadBinaryToDrive: vi.fn(async (fileName: string, _buf: Buffer, _mime: string, folder: string) => {
    driveUploads.push({ fileName, folder })
    return { id: 'drive-file-1' }
  }),
}))

vi.mock('@/lib/portal/auto-save-document', () => ({
  autoSaveDocument: vi.fn(async (p: Record<string, unknown>) => {
    autoSaveCalls.push(p)
    return autoSaveResult
  }),
}))

vi.mock('@/lib/portal/document-alerts', () => ({
  isNewDocumentAlertEnabled: vi.fn(async () => alertEnabled),
}))

vi.mock('@/lib/portal/notifications', () => ({
  createPortalNotification: vi.fn(async (p: { contact_id?: string; account_id?: string; title: string }) => {
    notifyCalls.push(p)
  }),
}))

vi.mock('@/lib/locale', () => ({ isItalian: (l: string | null | undefined) => l === 'Italian' }))

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const filters: Record<string, string> = {}
      let pendingUpdate: Record<string, unknown> | null = null
      let pendingUpsert: Record<string, unknown> | null = null
      const chain: Record<string, unknown> = {}
      Object.assign(chain, {
        select: () => chain,
        eq: (col: string, val: string) => { filters[col] = val; return chain },
        is: () => chain,
        update: (payload: Record<string, unknown>) => { pendingUpdate = payload; return chain },
        upsert: (payload: Record<string, unknown>) => { pendingUpsert = payload; return chain },
        single: () => {
          if (table === 'accounts') return Promise.resolve({ data: accountRow, error: null })
          if (table === 'contacts') return Promise.resolve({ data: { language: contactLang[filters.id] ?? null }, error: null })
          return Promise.resolve({ data: null, error: null })
        },
        then: (resolve: (v: unknown) => void) => {
          if (pendingUpdate && table === 'documents') { docUpdates.push(pendingUpdate); return resolve({ data: null, error: null }) }
          if (pendingUpsert) { viewUpserts.push(pendingUpsert); return resolve({ data: null, error: null }) }
          if (table === 'account_contacts') return resolve({ data: accountContactLinks, error: null })
          return resolve({ data: null, error: null })
        },
      })
      return chain
    },
  },
}))

beforeEach(() => {
  accountRow = { drive_folder_id: 'folder-1', company_name: 'Example LLC' }
  autoSaveResult = { id: 'doc-1' }
  alertEnabled = true
  accountContactLinks = [{ contact_id: 'maker' }]
  for (const k of Object.keys(contactLang)) delete contactLang[k]
  driveUploads.length = 0
  autoSaveCalls.length = 0
  docUpdates.length = 0
  viewUpserts.length = 0
  notifyCalls.length = 0
})

const baseParams = () => ({
  accountId: 'acct-1',
  contactId: 'maker',
  fileBuffer: Buffer.from('%PDF-1.4 test'),
  fileName: 'Distribution_SIGNED.pdf',
  documentType: 'Distribution Resolution',
})

describe('saveSignedGeneratedDocument', () => {
  it('errors when the account has no Drive folder', async () => {
    accountRow = { drive_folder_id: null, company_name: 'Example LLC' }
    const { saveSignedGeneratedDocument } = await import('@/lib/portal/save-generated-document')
    const r = await saveSignedGeneratedDocument(baseParams())
    expect(r.success).toBe(false)
    expect(r.error).toContain('Drive folder')
    expect(driveUploads.length).toBe(0)
  })

  it('saves via the canonical path (portal-visible), stamps it new, and pre-marks the maker as seen', async () => {
    const { saveSignedGeneratedDocument } = await import('@/lib/portal/save-generated-document')
    const r = await saveSignedGeneratedDocument({ ...baseParams(), category: 1 })
    expect(r.success).toBe(true)
    expect(r.documentId).toBe('doc-1')
    expect(driveUploads[0]).toEqual({ fileName: 'Distribution_SIGNED.pdf', folder: 'folder-1' })
    expect(autoSaveCalls[0]).toMatchObject({ accountId: 'acct-1', contactId: 'maker', portalVisible: true, category: 1, driveFileId: 'drive-file-1' })
    // stamped "new"
    expect(typeof docUpdates[0].client_notified_at).toBe('string')
    // maker pre-marked as viewed → no pulse / alert for them
    expect(viewUpserts[0]).toMatchObject({ document_id: 'doc-1', contact_id: 'maker' })
  })

  it('single-owner: alerts nobody (maker is the only contact)', async () => {
    accountContactLinks = [{ contact_id: 'maker' }]
    const { saveSignedGeneratedDocument } = await import('@/lib/portal/save-generated-document')
    const r = await saveSignedGeneratedDocument(baseParams())
    expect(r.coOwnersAlerted).toBe(0)
    expect(notifyCalls.length).toBe(0)
  })

  it('multi-owner: alerts co-owners but NEVER the maker, localized', async () => {
    accountContactLinks = [{ contact_id: 'maker' }, { contact_id: 'co-1' }, { contact_id: 'co-2' }]
    contactLang['co-1'] = 'Italian'
    contactLang['co-2'] = 'English'
    const { saveSignedGeneratedDocument } = await import('@/lib/portal/save-generated-document')
    const r = await saveSignedGeneratedDocument(baseParams())
    expect(r.coOwnersAlerted).toBe(2)
    expect(notifyCalls.map(n => n.contact_id).sort()).toEqual(['co-1', 'co-2'])
    expect(notifyCalls.some(n => n.contact_id === 'maker')).toBe(false)
    expect(notifyCalls.find(n => n.contact_id === 'co-1')!.title).toContain('Nuovo')
    expect(notifyCalls.find(n => n.contact_id === 'co-2')!.title).toContain('New')
  })

  it('respects the global new-document kill switch (no co-owner alerts when off)', async () => {
    alertEnabled = false
    accountContactLinks = [{ contact_id: 'maker' }, { contact_id: 'co-1' }]
    const { saveSignedGeneratedDocument } = await import('@/lib/portal/save-generated-document')
    const r = await saveSignedGeneratedDocument(baseParams())
    expect(r.success).toBe(true)
    expect(r.coOwnersAlerted).toBe(0)
    expect(notifyCalls.length).toBe(0)
  })

  it('returns an error + the orphan drive id when the record save fails', async () => {
    autoSaveResult = { error: 'insert boom' }
    const { saveSignedGeneratedDocument } = await import('@/lib/portal/save-generated-document')
    const r = await saveSignedGeneratedDocument(baseParams())
    expect(r.success).toBe(false)
    expect(r.error).toContain('Document record failed')
    expect(r.driveFileId).toBe('drive-file-1')
  })
})
