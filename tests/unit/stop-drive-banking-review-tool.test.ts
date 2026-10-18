/**
 * Stop Drive S1d: the banking_form_review MCP tool.
 *  - it FILES FIRST; a failed filing = "❌ … NOT marked as reviewed", the review is NOT applied, nothing says "Form marked as reviewed"
 *  - re-running after a failure files what is missing and then reviews
 *  - a form that is already reviewed is still filed (the re-run heals a failed filing) and the follow-up task is not duplicated
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const st = vi.hoisted(() => ({
  rows: {} as Record<string, unknown>,
  recorded: [] as Array<{ table: string; op: string; payload: unknown }>,
  pkg: { ok: true } as Record<string, unknown>,
  filed: 0,
  applied: 0,
  alreadyApplied: false,
  enqueued: 0,
}))
vi.mock('@/lib/supabase-admin', async () => ({ supabaseAdmin: (await import('./_legacy-drive-mocks')).makeSupabase(st.rows, st.recorded as never) }))
vi.mock('@/lib/forms/file-banking-package', () => ({ fileBankingPackage: async () => { st.filed++; return { copied: [], failed: [], errors: [], sentence: null, summaryFileId: null, pinFolderId: null, enqueueUnpinned: false, retryLater: false, ...st.pkg } } }))
vi.mock('@/lib/forms/archive-enqueue', () => ({ enqueueFormArchiveJob: async () => { st.enqueued++ } }))
vi.mock('@/lib/operations/banking-review', () => ({ approveAndApplyBankingReview: async () => { st.applied++; return { ok: true, alreadyApplied: st.alreadyApplied, services_update: 'updated' } } }))

type Handler = (a: { token: string; apply_changes?: boolean }) => Promise<{ content: Array<{ text: string }> }>
async function tool(): Promise<Handler> {
  const handlers: Record<string, Handler> = {}
  const { registerBankingFormTools } = await import('@/lib/mcp/tools/banking-form')
  registerBankingFormTools({ tool: (name: string, _d: string, _s: unknown, h: Handler) => { handlers[name] = h } } as never)
  return handlers['banking_form_review']
}

beforeEach(() => {
  st.filed = 0; st.applied = 0; st.alreadyApplied = false; st.enqueued = 0; st.pkg = { ok: true }; st.recorded.length = 0
  for (const k of Object.keys(st.rows)) delete st.rows[k]
  st.rows.banking_submissions = { id: 's1', token: 'tok', provider: 'relay', status: 'completed', account_id: 'acc-1', contact_id: 'c1', submitted_data: { business_name: 'Acme' }, upload_paths: [], changed_fields: null, completed_at: '2026-10-18T10:00:00Z' }
  st.rows.accounts = { company_name: 'Acme LLC' }
})

describe('banking_form_review', () => {
  it('a failed filing: reported as NOT filed, NOT reviewed, the review is not applied, no "marked as reviewed" line', async () => {
    st.pkg = { ok: false, sentence: 'This company is closed, so nothing new can be saved for it.', errors: ['This company is closed, so nothing new can be saved for it.'] }
    const text = (await (await tool())({ token: 'tok', apply_changes: true })).content[0].text
    expect(text).toMatch(/NOT filed/)
    expect(text).toMatch(/NOT marked as reviewed/)
    expect(text).not.toMatch(/Form marked as reviewed/)
    expect(st.applied).toBe(0)
  })
  it('after the problem is gone the same call files and then reviews', async () => {
    const text = (await (await tool())({ token: 'tok', apply_changes: true })).content[0].text
    expect(st.filed).toBe(1); expect(st.applied).toBe(1)
    expect(text).toMatch(/Form marked as reviewed/)
  })
  it('an already-reviewed form is still filed on a re-run (it heals a failed filing) and says so', async () => {
    st.alreadyApplied = true
    const text = (await (await tool())({ token: 'tok', apply_changes: true })).content[0].text
    expect(st.filed).toBe(1)
    expect(text).toMatch(/already reviewed/)
  })
  it('without apply_changes nothing is filed or applied', async () => {
    await (await tool())({ token: 'tok' })
    expect(st.filed).toBe(0); expect(st.applied).toBe(0)
  })
})
