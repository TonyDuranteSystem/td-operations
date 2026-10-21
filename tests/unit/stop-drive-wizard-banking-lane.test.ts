/**
 * Stop Drive S1d: the REAL /api/portal/wizard-submit banking lane (Relay/Payset) with the REAL filer and destination decisions. The
 * route answers at once and files in the background, so the test waits for the background work.
 *  - company in storage, no Drive folder: business papers -> company, passport + proof of address -> the person
 *  - the DURABLE core comes first: the row is saved (with the submitter's own contact id, an old "filed" mark cleared) and the retry job
 *    is queued BEFORE the long filing / chat / staff / task / delivery chain
 *  - the row's saved error is checked; the filing is not lost when it fails
 *  - WRONG MEMBER: the row was seeded with member A, member B submits, the first attempt fails -> the retry files B's papers in B's
 *    storage only
 *  - a teammate login naming a contact that is not one of the company's people is refused
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const st = vi.hoisted(() => ({
  rows: {} as Record<string, unknown>,
  recorded: [] as Array<{ table: string; op: string; payload: unknown }>,
  companyState: 'store' as 'store' | 'drive' | 'moving',
  identity: {} as Record<string, unknown>,
  failUpdates: [] as string[],
  failPersonOnce: false,
  companyCalls: [] as Array<{ folderId: string; paths: string[]; token: string; submittedAt: string }>,
  personCalls: [] as Array<{ target: { kind: string; id: string }; uploadPaths: string[] }>,
  enqueued: [] as Array<Record<string, unknown>>,
  alarms: [] as string[],
}))

vi.mock('@/lib/supabase/server', () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1', email: 'c@x.co', user_metadata: {} } } }) } }) }))
vi.mock('@/lib/auth', () => ({ isClient: () => true }))
vi.mock('@/lib/portal/resolve-portal-identity', () => ({ resolvePortalIdentity: async () => st.identity }))
vi.mock('@/lib/jobs/validation', () => ({ validateWizardData: () => ({ valid: true, errors: [], warnings: [] }) }))
vi.mock('@/lib/portal/wizard-progress-write', () => ({ markWizardProgressSubmitted: async () => ({ error: null }) }))
vi.mock('@/lib/supabase-admin', async () => ({ supabaseAdmin: (await import('./_legacy-drive-mocks')).makeSupabase(st.rows, st.recorded as never, {}, { applyUpdates: true, get failUpdatesOn() { return st.failUpdates } }) }))
vi.mock('@/lib/crm-store/switched-drive-guard', () => ({
  companyDocState: async () => st.companyState,
  liveOwnerOfAccount: async () => (st.companyState === 'drive' ? null : 'company-owner'),
  liveOwnerOfContact: async () => 'person-owner',
}))
vi.mock('@/lib/crm-store/formation-pilot', () => ({ raisePilotAlarm: async (k: string) => { st.alarms.push(k) }, ensurePersonOwner: async () => 'person-owner' }))
vi.mock('@/lib/form-to-drive', () => ({
  saveFormToDrive: async (_t: string, _d: unknown, paths: string[], folderId: string, meta: { token: string; submittedAt: string }) => {
    st.companyCalls.push({ folderId, paths, token: meta.token, submittedAt: meta.submittedAt })
    return { summaryFileId: 'store:s1', copied: paths, failed: [], skipped: [], errors: [] }
  },
}))
vi.mock('@/lib/crm-store/save-form', () => ({
  saveFormToStore: async (spec: { target: { kind: string; id: string }; uploadPaths: string[] }) => {
    st.personCalls.push({ target: spec.target, uploadPaths: spec.uploadPaths })
    if (st.failPersonOnce) { st.failPersonOnce = false; return { summaryFileId: null, copied: [], failed: spec.uploadPaths, skipped: [], errors: ['store down'] } }
    return { summaryFileId: null, copied: spec.uploadPaths, failed: [], skipped: [], errors: [] }
  },
}))
vi.mock('@/lib/forms/archive-enqueue', () => ({ enqueueFormArchiveJob: async (j: Record<string, unknown>) => { if (st.enqueued.some((e) => e.submissionId === j.submissionId)) return { status: 'already_queued' }; st.enqueued.push(j); st.recorded.push({ table: '__job', op: 'insert', payload: j }); return { status: 'enqueued' } } }))
vi.mock('@/lib/portal/auto-save-document', () => ({ autoSaveDocument: async () => ({}) }))
vi.mock('@/lib/portal/chat-events', () => ({ emitBankingWizardSubmittedEvent: async () => ({}), retireBankingWizardSubmittedNote: async () => ({}) }))
vi.mock('@/lib/notifications/act-event', () => ({ emitActionNeeded: async () => ({}) }))
vi.mock('@/lib/archive/meta-merge', () => ({ mergeArchiveMeta: async () => undefined }))
vi.mock('@/lib/system-errors', () => ({ reportSystemError: async (e: { message: string }) => { st.alarms.push(e.message) } }))

const PASSPORT = 'banking_relay/c1/passport_image_abc_front.jpg'
const PROOF = 'banking_relay/c1/proof_of_address_abc_bill.pdf'
const STATEMENT = 'banking_relay/c1/business_bank_statement_abc.pdf'
const DATA = { business_name: 'Acme LLC', passport_image: [PASSPORT], proof_of_address: [PROOF], business_bank_statement: [STATEMENT] }

beforeEach(async () => {
  ;(await import('@/lib/crm-store/legacy-drive')).forgetRecentAlarms()
  ;(await import('@/lib/crm-store/throttled-alarm')).forgetThrottledAlarms()
  st.companyCalls.length = 0; st.personCalls.length = 0; st.enqueued.length = 0; st.recorded.length = 0; st.alarms.length = 0
  st.failUpdates = []; st.failPersonOnce = false
  for (const k of Object.keys(st.rows)) delete st.rows[k]
  st.companyState = 'store'
  st.identity = { kind: 'contact', contactId: 'c1', accountIds: ['acc-1'] }
  // the row was seeded when the EIN was recorded: provider + account + (maybe) a contact, never the answers
  st.rows.banking_submissions = { id: 's1', token: 'tok-s1', provider: 'relay', account_id: 'acc-1', contact_id: 'c1', status: 'pending', submitted_data: null, upload_paths: null, completed_at: null, drive_archived_at: null, drive_archive_meta: null }
  st.rows.accounts = { status: 'Active', drive_folder_id: null, gdrive_folder_url: null, company_name: 'Acme LLC' }
  st.rows.contacts = { full_name: 'Maria Rossi' }
  st.rows.store_owners = []
  st.rows.account_contacts = [{ contact_id: 'c1' }]
})

const submit = async (body: Record<string, unknown> = {}) => {
  const { POST } = await import('@/app/api/portal/wizard-submit/route')
  return POST(new NextRequest('http://localhost/api/portal/wizard-submit', {
    method: 'POST',
    body: JSON.stringify({ wizard_type: 'banking_relay', data: DATA, account_id: 'acc-1', contact_id: 'c1', progress_id: 'p1', ...body }),
  }))
}
const idx = (pred: (r: { table: string; op: string; payload: unknown }) => boolean) => st.recorded.findIndex(pred)

describe('/api/portal/wizard-submit — banking lane', () => {
  it('company in storage: every paper -> company, only the passport -> person, the row and the PDF share one completed_at; fully filed -> marker set', async () => {
    expect((await submit()).status).toBe(200)
    await vi.waitFor(() => expect(st.recorded.some((r) => r.table === 'banking_submissions' && typeof (r.payload as Record<string, unknown>).drive_archived_at === 'string')).toBe(true), { timeout: 3000 })
    expect(st.companyCalls).toHaveLength(1)
    expect(st.companyCalls[0]).toMatchObject({ folderId: 'account-storage:acc-1', paths: [PROOF, STATEMENT], token: 'tok-s1' })
    expect(st.personCalls[0]).toMatchObject({ target: { kind: 'contact', id: 'c1' }, uploadPaths: [PASSPORT] })
    const upd = st.recorded.find((r) => r.table === 'banking_submissions' && r.op === 'update' && (r.payload as Record<string, unknown>).status === 'completed')
    const completedAt = (upd?.payload as Record<string, string>).completed_at
    expect(completedAt).toBeTruthy()
    expect(st.companyCalls[0].submittedAt.slice(0, 10)).toBe(completedAt.slice(0, 10))
    // the wizard row is a WIZARD row (one summary key for every later lane) and records who submitted it
    const meta = (upd?.payload as { drive_archive_meta: Record<string, unknown> }).drive_archive_meta
    expect(meta).toMatchObject({ origin: 'wizard', applicant: 'submitter' })
    expect((upd?.payload as Record<string, unknown>).drive_archived_at).toBeNull() // a NEW submission clears an older filed mark
  })
  it('the DURABLE core comes first: row saved, retry job queued, THEN the filing and the chat / staff / task steps', async () => {
    await submit()
    await vi.waitFor(() => expect(st.recorded.some((r) => r.table === 'tasks' && r.op === 'insert')).toBe(true), { timeout: 3000 })
    const saved = idx((r) => r.table === 'banking_submissions' && r.op === 'update' && (r.payload as Record<string, unknown>).status === 'completed')
    const job = idx((r) => r.table === '__job')
    expect(saved).toBeGreaterThanOrEqual(0)
    expect(job).toBeGreaterThan(saved)
    for (const later of [idx((r) => r.table === 'portal_messages' && r.op === 'insert'), idx((r) => r.table === 'tasks' && r.op === 'insert'), idx((r) => r.table === 'action_log')]) expect(later).toBeGreaterThan(job)
    expect(st.enqueued[0]).toMatchObject({ formType: 'banking', submissionId: 's1' })
  })
  it('the row could not be saved: ONE system error says so (nothing is silent) and the files are still filed from the answers', async () => {
    st.failUpdates = ['banking_submissions']
    await submit()
    await vi.waitFor(() => expect(st.companyCalls.length).toBe(1), { timeout: 3000 })
    expect(st.alarms.some((m) => /could not be saved/.test(m))).toBe(true)
  })
  it('company moving: nothing is filed now, the retry job is already queued, and the staff task / chat message still go out', async () => {
    st.companyState = 'moving'
    await submit()
    await vi.waitFor(() => expect(st.recorded.some((r) => r.table === 'tasks' && r.op === 'insert')).toBe(true), { timeout: 3000 })
    expect(st.companyCalls).toEqual([])
    expect(st.enqueued).toHaveLength(1)
    expect(st.recorded.some((r) => r.table === 'portal_messages' && r.op === 'insert')).toBe(true)
  })
  it('WRONG MEMBER: seeded with member A, member B submits, the first attempt fails -> the retry files B\'s papers in B\'s storage only', async () => {
    ;(st.rows.banking_submissions as Record<string, unknown>).contact_id = 'memberA'
    st.rows.account_contacts = [{ contact_id: 'memberA' }, { contact_id: 'memberB' }]
    st.identity = { kind: 'contact', contactId: 'memberB', accountIds: ['acc-1'] }
    st.failPersonOnce = true
    await submit({ contact_id: 'memberB' })
    await vi.waitFor(() => expect(st.personCalls.length).toBe(1), { timeout: 3000 })
    expect(st.personCalls[0].target.id).toBe('memberB')
    expect((st.rows.banking_submissions as Record<string, unknown>).contact_id).toBe('memberB')
    // the retry (the durable job / sweep) reads the row: member B, never A
    const { archiveFormSubmission } = await import('@/lib/forms/archive-submission')
    await archiveFormSubmission('banking', 's1')
    expect(st.personCalls.map((c) => c.target.id)).toEqual(['memberB', 'memberB'])
    expect(st.personCalls[1].uploadPaths).toEqual([PASSPORT])
  })
  it('a teammate login (no person of its own) in a company with SEVERAL people: the personal papers are held with ONE alarm, never guessed', async () => {
    st.identity = { kind: 'teammate', accountId: 'acc-1' }
    st.rows.account_contacts = [{ contact_id: 'c1' }, { contact_id: 'c2' }]
    await submit({ contact_id: null })
    await vi.waitFor(() => expect(st.recorded.some((r) => r.table === 'tasks' && r.op === 'insert')).toBe(true), { timeout: 3000 })
    expect(st.personCalls).toEqual([])
    expect(st.alarms.filter((a) => a === 'banking_package_problem')).toHaveLength(1)
  })
  it('a teammate login in a company with ONE person: the row\'s contact is that person, so the first attempt files their papers (no false alarm)', async () => {
    st.identity = { kind: 'teammate', accountId: 'acc-1' }
    await submit({ contact_id: null })
    await vi.waitFor(() => expect(st.personCalls.length).toBe(1), { timeout: 3000 })
    expect(st.personCalls[0].target.id).toBe('c1')
    expect(st.alarms).toEqual([])
  })
  it('a teammate login naming a contact that is NOT one of the company\'s people is refused', async () => {
    st.identity = { kind: 'teammate', accountId: 'acc-1' }
    st.rows.account_contacts = null
    expect((await submit({ contact_id: 'someone-else' })).status).toBe(403)
    expect(st.personCalls).toEqual([])
  })
})
