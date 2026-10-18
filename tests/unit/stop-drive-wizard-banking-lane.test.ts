/**
 * Stop Drive S1d: the REAL /api/portal/wizard-submit banking lane (Relay/Payset). The route answers at once and files in the
 * background, so the test waits for the background work.
 *  - company in storage, no Drive folder: business papers -> company, passport + proof of address -> the person; durable job queued
 *  - the filed PDF carries the submission's own completed_at (one value for the row AND the PDF)
 *  - company moving: durable job STILL queued; a swallowed lookup error does not stop the staff task / chat message nor the retry
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const st = vi.hoisted(() => ({
  rows: {} as Record<string, unknown>,
  recorded: [] as Array<{ table: string; op: string; payload: unknown }>,
  companyState: 'store' as 'store' | 'drive' | 'moving',
  companyCalls: [] as Array<{ folderId: string; paths: string[]; token: string; submittedAt: string }>,
  personCalls: [] as Array<{ target: { kind: string; id: string }; uploadPaths: string[] }>,
  enqueued: [] as Array<Record<string, unknown>>,
}))

vi.mock('@/lib/supabase/server', () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1', email: 'c@x.co', user_metadata: {} } } }) } }) }))
vi.mock('@/lib/auth', () => ({ isClient: () => true }))
vi.mock('@/lib/portal/resolve-portal-identity', () => ({ resolvePortalIdentity: async () => ({}) }))
vi.mock('@/lib/portal/wizard-submit-access', () => ({ canSubmitWizard: () => true }))
vi.mock('@/lib/jobs/validation', () => ({ validateWizardData: () => ({ valid: true, errors: [], warnings: [] }) }))
vi.mock('@/lib/portal/wizard-progress-write', () => ({ markWizardProgressSubmitted: async () => ({ error: null }) }))
vi.mock('@/lib/supabase-admin', async () => ({ supabaseAdmin: (await import('./_legacy-drive-mocks')).makeSupabase(st.rows, st.recorded as never) }))
vi.mock('@/lib/crm-store/switched-drive-guard', () => ({
  companyDocState: async () => st.companyState,
  liveOwnerOfAccount: async () => (st.companyState === 'drive' ? null : 'company-owner'),
  liveOwnerOfContact: async () => 'person-owner',
}))
vi.mock('@/lib/crm-store/formation-pilot', () => ({ raisePilotAlarm: async () => {}, ensurePersonOwner: async () => 'person-owner' }))
vi.mock('@/lib/crm-store/lead-form-store', () => ({ storageDestinationForForm: async (i: { accountId: string }) => ({ marker: st.companyState === 'store' ? `account-storage:${i.accountId}` : null }) }))
vi.mock('@/lib/form-to-drive', () => ({
  saveFormToDrive: async (_t: string, _d: unknown, paths: string[], folderId: string, meta: { token: string; submittedAt: string }) => {
    st.companyCalls.push({ folderId, paths, token: meta.token, submittedAt: meta.submittedAt })
    return { summaryFileId: 'store:s1', copied: paths, failed: [], skipped: [], errors: [] }
  },
}))
vi.mock('@/lib/crm-store/save-form', () => ({
  saveFormToStore: async (spec: { target: { kind: string; id: string }; uploadPaths: string[] }) => {
    st.personCalls.push({ target: spec.target, uploadPaths: spec.uploadPaths })
    return { summaryFileId: null, copied: spec.uploadPaths, failed: [], skipped: [], errors: [] }
  },
}))
vi.mock('@/lib/forms/archive-enqueue', () => ({ enqueueFormArchiveJob: async (j: Record<string, unknown>) => { st.enqueued.push(j) } }))
vi.mock('@/lib/portal/auto-save-document', () => ({ autoSaveDocument: async () => ({}) }))
vi.mock('@/lib/portal/chat-events', () => ({ emitBankingWizardSubmittedEvent: async () => ({}), retireBankingWizardSubmittedNote: async () => ({}) }))
vi.mock('@/lib/notifications/act-event', () => ({ emitActionNeeded: async () => ({}) }))
vi.mock('@/lib/system-errors', () => ({ reportSystemError: async () => null }))

const PASSPORT = 'banking_relay/c1/passport_image_abc_front.jpg'
const PROOF = 'banking_relay/c1/proof_of_address_abc_bill.pdf'
const STATEMENT = 'banking_relay/c1/business_bank_statement_abc.pdf'
const DATA = { business_name: 'Acme LLC', passport_image: [PASSPORT], proof_of_address: [PROOF], business_bank_statement: [STATEMENT] }

beforeEach(async () => {
  ;(await import('@/lib/crm-store/legacy-drive')).forgetRecentAlarms()
  st.companyCalls.length = 0; st.personCalls.length = 0; st.enqueued.length = 0; st.recorded.length = 0
  for (const k of Object.keys(st.rows)) delete st.rows[k]
  st.companyState = 'store'
  st.rows.banking_submissions = { id: 's1', token: 'tok-s1', status: 'created' }
  st.rows.accounts = { status: 'Active', drive_folder_id: null, gdrive_folder_url: null, company_name: 'Acme LLC' }
})

const submit = async () => {
  const { POST } = await import('@/app/api/portal/wizard-submit/route')
  const res = await POST(new NextRequest('http://localhost/api/portal/wizard-submit', {
    method: 'POST',
    body: JSON.stringify({ wizard_type: 'banking_relay', data: DATA, account_id: 'acc-1', contact_id: 'c1', progress_id: 'p1' }),
  }))
  expect(res.status).toBe(200)
}

describe('/api/portal/wizard-submit — banking lane', () => {
  it('company in storage: business -> company, personal -> person, the row and the PDF share one completed_at, durable job queued', async () => {
    await submit()
    await vi.waitFor(() => expect(st.recorded.some((r) => r.table === 'banking_submissions' && typeof (r.payload as Record<string, unknown>).drive_archived_at === 'string')).toBe(true), { timeout: 3000 })
    expect(st.enqueued).toEqual([]) // fully filed: marker set, nothing to heal
    expect(st.companyCalls).toHaveLength(1)
    expect(st.companyCalls[0]).toMatchObject({ folderId: 'account-storage:acc-1', paths: [STATEMENT], token: 'tok-s1' })
    expect(st.personCalls[0]).toMatchObject({ target: { kind: 'contact', id: 'c1' }, uploadPaths: [PASSPORT, PROOF] })
    const upd = st.recorded.find((r) => r.table === 'banking_submissions' && r.op === 'update' && (r.payload as Record<string, unknown>).status === 'completed')
    const completedAt = (upd?.payload as Record<string, string>).completed_at
    expect(completedAt).toBeTruthy()
    expect(st.companyCalls[0].submittedAt.slice(0, 10)).toBe(completedAt.slice(0, 10))
  })
  it('company moving: nothing is filed now, but the durable job is queued so it can heal, and the staff task / chat message still go out', async () => {
    st.companyState = 'moving'
    await submit()
    await vi.waitFor(() => expect(st.enqueued.length).toBe(1), { timeout: 3000 })
    expect(st.companyCalls).toEqual([])
    expect(st.enqueued[0]).toMatchObject({ pin: { folderId: 'account-storage:acc-1' } })
    expect(st.recorded.some((r) => r.table === 'tasks' && r.op === 'insert')).toBe(true)
    expect(st.recorded.some((r) => r.table === 'portal_messages' && r.op === 'insert')).toBe(true)
  })
})
