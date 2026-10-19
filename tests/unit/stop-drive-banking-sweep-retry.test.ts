/**
 * Stop Drive S1d: the retry + alarm path for a failed banking filing, with the date set (the clock is a parameter).
 *  - a row filed INLINE sets the same marker the archive job sets -> the sweep skips it (the "not filed anywhere" alarm cannot fire)
 *  - a row whose filing FAILED has no marker -> the sweep re-queues it, and after the attempt limit alerts staff ONCE
 *  - the archive job: first run fails (attempt counted, error recorded, the job throws so it is retried); second run files and sets the marker
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { decideFormArchiveSweep, FORM_ARCHIVE_SWEEP_MAX_ATTEMPTS, FORM_ARCHIVE_SWEEP_ALERTED_KEY } from '@/lib/forms/archive-sweep'
import { ARCHIVE_RECIPES } from '@/lib/forms/archive-registry'

const NOW = new Date('2026-10-22T12:00:00Z') // after every form's sweep start date (19 Oct)
const PIN = { pinned_plan: { folderId: 'person-storage:c1', bucket: 'b', configKey: 'x', uploadPaths: [] } }
const row = (over: Record<string, unknown>) => ({ id: 'r1', status: 'completed', contact_id: 'c1', created_at: '2026-10-20T09:00:00Z', drive_archived_at: null, drive_archive_meta: PIN, ...over })

describe('the sweep decision, banking + formation, with the clock set', () => {
  for (const type of ['banking', 'formation'] as const) {
    const recipe = ARCHIVE_RECIPES[type]
    it(`${type}: a row filed inline (marker set) is left alone`, () => {
      expect(decideFormArchiveSweep(row({ drive_archived_at: '2026-10-20T09:05:00Z' }), recipe, NOW)).toBe('skip')
    })
    it(`${type}: a row whose filing failed (no marker) is re-queued`, () => {
      expect(decideFormArchiveSweep(row({ drive_archive_meta: { ...PIN, attempts: 1, last_error: 'storage down' } }), recipe, NOW)).toBe('enqueue')
    })
    it(`${type}: after the attempt limit staff are alerted ONCE, then it is quiet`, () => {
      expect(decideFormArchiveSweep(row({ drive_archive_meta: { ...PIN, attempts: FORM_ARCHIVE_SWEEP_MAX_ATTEMPTS } }), recipe, NOW)).toBe('alert')
      expect(decideFormArchiveSweep(row({ drive_archive_meta: { ...PIN, attempts: FORM_ARCHIVE_SWEEP_MAX_ATTEMPTS, [FORM_ARCHIVE_SWEEP_ALERTED_KEY]: true } }), recipe, NOW)).toBe('skip')
    })
  }
  it('formation / onboarding rows filed before they had a retry path (no pinned plan) are not touched; banking rows are re-queued either way', () => {
    expect(decideFormArchiveSweep(row({ drive_archive_meta: null }), ARCHIVE_RECIPES.formation, NOW)).toBe('skip')
    expect(decideFormArchiveSweep(row({ drive_archive_meta: null }), ARCHIVE_RECIPES.banking, NOW)).toBe('enqueue')
  })
})

describe('the archive job: fail, then retry and set the marker', () => {
  const st = vi.hoisted(() => ({ row: {} as Record<string, unknown>, updates: [] as Array<Record<string, unknown>>, pkgOk: false }))
  vi.mock('@/lib/supabase-admin', () => {
    const b = () => {
      const c: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'order', 'limit']) c[m] = () => c
      c.update = (p: Record<string, unknown>) => { st.updates.push(p); return c }
      c.maybeSingle = () => Promise.resolve({ data: st.row, error: null })
      c.then = (r: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(r)
      return c
    }
    return { supabaseAdmin: { from: b } }
  })
  vi.mock('@/lib/forms/file-banking-package', () => ({
    fileBankingPackage: async () => (st.pkgOk
      ? { ok: true, summaryFileId: 'store:s', copied: ['a.pdf'], failed: [], errors: [], pinFolderId: 'account-storage:acc-1', retryLater: false, enqueueUnpinned: false, sentence: null }
      : { ok: false, summaryFileId: null, copied: [], failed: ['passport (no person to file it under)'], errors: ['not filed'], pinFolderId: 'account-storage:acc-1', retryLater: false, enqueueUnpinned: false, sentence: null }),
  }))
  vi.mock('@/lib/form-to-drive', () => ({ saveFormToDrive: async () => { throw new Error('the banking job must use the banking filer') } }))

  beforeEach(() => {
    st.updates.length = 0; st.pkgOk = false
    st.row = {
      id: 's1', account_id: 'acc-1', contact_id: 'c1', token: 'tok', provider: 'relay', status: 'completed', submitted_data: {}, upload_paths: [], completed_at: '2026-10-20T09:00:00Z', created_at: '2026-10-20T09:00:00Z',
      drive_archived_at: null, drive_archive_meta: { pinned_plan: { folderId: 'account-storage:acc-1', bucket: 'onboarding-uploads', configKey: 'banking_relay', uploadPaths: [], companyName: 'Acme' } },
    }
  })

  it('first run: the job throws (so the queue retries), the attempt and the error are recorded, NO marker', async () => {
    const { archiveFormSubmission } = await import('@/lib/forms/archive-submission')
    await expect(archiveFormSubmission('banking', 's1')).rejects.toThrow(/not fully archived/)
    const meta = st.updates.map((u) => u.drive_archive_meta as Record<string, unknown>).find(Boolean)
    expect(meta).toMatchObject({ attempts: 1 })
    expect(String(meta.last_error)).toMatch(/not filed|failed/)
    expect(st.updates.some((u) => u.drive_archived_at)).toBe(false)
  })
  it('after the problem is gone the retry files everything and sets the marker', async () => {
    st.pkgOk = true
    const { archiveFormSubmission } = await import('@/lib/forms/archive-submission')
    const r = await archiveFormSubmission('banking', 's1')
    expect(r.status).toBe('archived')
    expect(st.updates.some((u) => typeof u.drive_archived_at === 'string')).toBe(true)
  })
})
