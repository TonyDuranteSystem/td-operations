/**
 * Stop Drive S1d, form lanes round 3 — item 8: a company mid-move is waiting, not failing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

describe('8. a company mid-move is waiting, not failing', () => {
  const st = vi.hoisted(() => ({ row: {} as Record<string, unknown>, updates: [] as Array<Record<string, unknown>> }))
  vi.mock('@/lib/forms/file-banking-submission', async (orig) => ({
    ...(await orig<typeof import('@/lib/forms/file-banking-submission')>()),
    buildBankingInput: async () => ({ flow: 'x', formType: 'banking_relay', accountId: 'acc-1', contactId: 'c1', submittedData: {}, uploadPaths: [], bucket: 'b', token: 't' }),
  }))
  vi.mock('@/lib/forms/file-banking-package', () => ({ fileBankingPackage: async () => ({ ok: false, summaryFileId: null, copied: [], failed: [], errors: ['moving'], pinFolderId: 'account-storage:acc-1', retryLater: true, enqueueUnpinned: false, sentence: 'moving', heldPersonal: [] }) }))
  vi.mock('@/lib/supabase-admin', () => {
    const sb = () => {
      const c: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'order', 'limit']) c[m] = () => c
      c.update = (p: Record<string, unknown>) => { st.updates.push(p); return c }
      c.maybeSingle = () => Promise.resolve({ data: st.row, error: null })
      c.then = (r: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(r)
      return c
    }
    return { supabaseAdmin: { from: () => sb() } }
  })
  const base = { id: 's1', account_id: 'acc-1', contact_id: 'c1', token: 'tok', provider: 'relay', status: 'completed', submitted_data: {}, upload_paths: [], completed_at: '2026-10-20T09:00:00Z', created_at: '2026-10-20T09:00:00Z', drive_archived_at: null }
  beforeEach(() => { st.updates.length = 0 })
  it('the first waits do not use up attempts; the wait is remembered', async () => {
    st.row = { ...base, drive_archive_meta: { attempts: 1 } }
    const { archiveFormSubmission } = await import('@/lib/forms/archive-submission')
    await expect(archiveFormSubmission('banking', 's1')).rejects.toThrow(/not fully archived/)
    const meta = st.updates.map((u) => u.drive_archive_meta as Record<string, unknown>).find(Boolean)!
    expect(meta.attempts).toBe(1)
    expect(typeof meta.waiting_since).toBe('string')
  })
  it('after more than 6 hours of waiting it counts as a failed attempt (the sweep then alerts once)', async () => {
    st.row = { ...base, drive_archive_meta: { attempts: 1, waiting_since: new Date(Date.now() - 7 * 3600_000).toISOString() } }
    const { archiveFormSubmission } = await import('@/lib/forms/archive-submission')
    await expect(archiveFormSubmission('banking', 's1')).rejects.toThrow()
    const meta = st.updates.map((u) => u.drive_archive_meta as Record<string, unknown>).find(Boolean)!
    expect(meta.attempts).toBe(2)
  })
})

