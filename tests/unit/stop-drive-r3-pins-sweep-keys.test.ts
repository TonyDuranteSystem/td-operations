/**
 * Stop Drive S1d, form lanes round 3 — items 5b, 7, 9, 10: a pinned Drive id is ignored, the banking sweep start date, one summary key + the applicant rule, the alarm told once.
 */
import { describe, it, expect, vi } from 'vitest'

describe('5b. a pinned Drive folder id is ignored', () => {
  it('the destination is looked up again; a pin counts only when it is THIS company\'s storage marker', async () => {
    const { fileBankingPackage } = await import('@/lib/forms/file-banking-package')
    const asked: string[] = []
    const deps = {
      destination: async (id: string | null | undefined) => { asked.push(String(id)); return { ok: true, folderId: 'account-storage:acc-1', via: 'storage' as const } },
      saveCompany: async (i: { folderId: string; paths: string[] }) => ({ summaryFileId: 's', copied: i.paths, failed: [], errors: [] }),
      savePerson: async (i: { paths: string[] }) => ({ copied: i.paths, failed: [], errors: [] }),
      alarm: async () => {}, now: () => new Date('2026-10-18T10:00:00Z'),
    }
    const base = { flow: 'x', formType: 'banking_relay', accountId: 'acc-1', contactId: 'c1', submittedData: {}, uploadPaths: ['banking_relay/c1/passport_image_a.jpg', 'banking_relay/c1/business_bank_statement_a.pdf'], bucket: 'b', token: 't' }
    const r = await fileBankingPackage({ ...base, folderId: '1AbCdriveFolderId' }, deps)
    expect(asked).toEqual(['acc-1'])
    expect(r.ok).toBe(true)
    await fileBankingPackage({ ...base, folderId: 'account-storage:OTHER' }, deps)
    expect(asked).toHaveLength(2)
    await fileBankingPackage({ ...base, folderId: 'account-storage:acc-1' }, deps)
    expect(asked).toHaveLength(2) // honoured: it is this company's marker
  })
})

describe('7. the banking sweep has its own start date', () => {
  it('a banking row from before it is never swept by the new rules; one after it is', async () => {
    const { decideFormArchiveSweep } = await import('@/lib/forms/archive-sweep')
    const { ARCHIVE_RECIPES, BANKING_SWEEP_NOT_BEFORE_ISO } = await import('@/lib/forms/archive-registry')
    const now = new Date(Date.parse(BANKING_SWEEP_NOT_BEFORE_ISO) + 7 * 86400_000)
    const row = (created: string) => ({ id: 'r', status: 'completed', created_at: created, drive_archived_at: null, drive_archive_meta: null })
    expect(decideFormArchiveSweep(row('2026-09-01T00:00:00Z'), ARCHIVE_RECIPES.banking, now)).toBe('skip')
    expect(decideFormArchiveSweep(row(new Date(Date.parse(BANKING_SWEEP_NOT_BEFORE_ISO) + 3600_000).toISOString()), ARCHIVE_RECIPES.banking, now)).toBe('enqueue')
  })
})


describe('9/10. one summary key, the applicant rule, the alarm told once', () => {
  it('a wizard row and a public-form row get different, STABLE summary configs; review of a wizard row uses the wizard\'s', async () => {
    const { bankingOriginOf, buildBankingInput } = await import('@/lib/forms/file-banking-submission')
    const wiz = { id: 'a', token: 't', provider: 'relay', account_id: null, contact_id: 'c1', submitted_data: {}, upload_paths: null, completed_at: '2026-10-18T10:00:00Z', drive_archive_meta: { origin: 'wizard' } }
    const ext = { ...wiz, upload_paths: ['t/1/passport_image_x.jpg'], drive_archive_meta: null }
    expect(bankingOriginOf(wiz)).toBe('wizard'); expect(bankingOriginOf(ext)).toBe('external')
    expect((await buildBankingInput(wiz, 'banking_form_review', { companyName: 'Acme' })).formType).toBe('banking_relay')
    expect((await buildBankingInput(ext, 'banking_form_review', { companyName: 'Acme' })).formType).toBe('banking')
  })
  it('the applicant: the submitter always; a public-form row its contact; a wizard row\'s seeded contact ONLY when the company has exactly one person', async () => {
    const { resolveBankingApplicant } = await import('@/lib/forms/file-banking-submission')
    const row = { account_id: 'acc-1', contact_id: 'A', upload_paths: null, drive_archive_meta: null as Record<string, unknown> | null }
    const people = (ids: string[]) => ({ linkedContacts: async () => ids })
    expect(await resolveBankingApplicant({ ...row, drive_archive_meta: { applicant: 'submitter', origin: 'wizard' } }, people(['A', 'B']))).toBe('A')
    expect(await resolveBankingApplicant({ ...row, upload_paths: ['x/passport.jpg'] }, people(['A', 'B']))).toBe('A')
    expect(await resolveBankingApplicant(row, people(['A']))).toBe('A')
    expect(await resolveBankingApplicant(row, people(['A', 'B']))).toBeNull()
    expect(await resolveBankingApplicant({ ...row, contact_id: null }, people(['A']))).toBeNull()
  })
  it('markBankingSubmissionFiled / a new submission clear the failed-attempt count and the alerted flag', async () => {
    const { freshSubmissionMeta } = await import('@/lib/forms/mark-banking-filed')
    expect(freshSubmissionMeta({ attempts: 5, sweep_alerted: true, pinned_plan: {}, last_error: 'x', keep: 1 }, { origin: 'wizard' })).toEqual({ keep: 1, origin: 'wizard' })
  })
  it('the same alarm is raised once an hour', async () => {
    const { raiseThrottledAlarm, forgetThrottledAlarms } = await import('@/lib/crm-store/throttled-alarm')
    forgetThrottledAlarms()
    const raised: string[] = []
    const deps = { alreadyAlarmed: async () => false, raise: async (k: string) => { raised.push(k) } }
    const d = { flow: 'x', token: 't' }
    expect(await raiseThrottledAlarm('banking_package_problem', d, 1_000, deps)).toBe(true)
    expect(await raiseThrottledAlarm('banking_package_problem', d, 2_000, deps)).toBe(false)
    expect(await raiseThrottledAlarm('banking_package_problem', { ...d, token: 'other' }, 2_000, deps)).toBe(true)
    expect(await raiseThrottledAlarm('banking_package_problem', d, 1_000 + 61 * 60_000, deps)).toBe(true)
    expect(raised).toHaveLength(3)
  })
})

describe('the filed mark merges (does not overwrite) the meta, and resets the old failures', () => {
  it('sets the marker, then MERGES attempts 0 / alerted flag cleared / not waiting — nothing else is rewritten', async () => {
    vi.resetModules()
    const updates: Array<Record<string, unknown>> = [], merged: Array<Record<string, unknown>> = []
    vi.doMock('@/lib/supabase-admin', () => ({ supabaseAdmin: { from: () => { const c: Record<string, unknown> = {}; c.update = (p: Record<string, unknown>) => { updates.push(p); return c }; c.eq = () => Promise.resolve({ error: null }); return c } } }))
    vi.doMock('@/lib/archive/meta-merge', () => ({ mergeArchiveMeta: async (_t: string, _id: string, patch: Record<string, unknown>) => { merged.push(patch) } }))
    const { markBankingSubmissionFiled } = await import('@/lib/forms/mark-banking-filed')
    expect(await markBankingSubmissionFiled('s1', { flow: 'x', summaryFileId: 'f', copied: ['a'], folderId: 'account-storage:a' })).toBe(true)
    expect(typeof updates[0].drive_archived_at).toBe('string')
    expect(updates[0].drive_archive_meta).toBeUndefined()
    expect(merged[0]).toMatchObject({ attempts: 0, sweep_alerted: null, waiting_since: null, last_error: null })
    vi.doUnmock('@/lib/supabase-admin'); vi.doUnmock('@/lib/archive/meta-merge')
  })
})
