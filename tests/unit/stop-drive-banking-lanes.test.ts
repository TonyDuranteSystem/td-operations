/**
 * Stop Drive S1d: the banking lanes, with the REAL route / recipe / filer / destination decisions. Only the database rows, the
 * storage state and the two writers (company package, person papers) are fakes.
 *  - a company in storage (NO Drive folder): the summary + business papers go to the company marker, the client's PERSONAL papers
 *    go to the PERSON's own storage — never into the company's folder
 *  - no person to file the personal papers under: not filed, ONE alarm, the step is an error
 *  - company moving: an error AND the durable job is still queued (pinned to the storage marker) so it can heal
 *  - Closed company: error + ONE alarm; replaying the same POST does not flood the alarm
 *  - the sweep recipe no longer throws "NO drive_folder_id" for a company in storage
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const st = vi.hoisted(() => ({
  rows: {} as Record<string, unknown>,
  recorded: [] as Array<{ table: string; op: string; payload: unknown }>,
  companyState: 'store' as 'store' | 'drive' | 'moving',
  /** the person's storage: a live one, only a hidden study copy, or none yet */
  personOwner: 'live' as 'live' | 'study' | 'none',
  ensureNames: [] as string[],
  companyCalls: [] as Array<{ folderId: string; paths: string[]; token: string; submittedAt: string }>,
  personCalls: [] as Array<{ target: { kind: string; id: string }; uploadPaths: string[] }>,
  enqueued: [] as Array<Record<string, unknown>>,
  alarms: [] as string[],
  pilotAlarms: [] as string[],
}))

vi.mock('@/lib/supabase-admin', async () => ({ supabaseAdmin: (await import('./_legacy-drive-mocks')).makeSupabase(st.rows, st.recorded as never) }))
vi.mock('@/lib/crm-store/switched-drive-guard', () => ({
  companyDocState: async () => st.companyState,
  liveOwnerOfAccount: async () => (st.companyState === 'drive' ? null : 'company-owner'),
  // the REAL meaning: a hidden study copy is NOT a live owner
  liveOwnerOfContact: async () => (st.personOwner === 'live' ? 'person-owner' : null),
}))
vi.mock('@/lib/crm-store/formation-pilot', () => ({
  raisePilotAlarm: async (kind: string) => { st.pilotAlarms.push(kind) },
  // like the real store_ensure_owner: it hands back the EXISTING owner (even a study copy) or opens one
  ensurePersonOwner: async (_id: string, name: string) => { st.ensureNames.push(name); if (st.personOwner === 'none') st.personOwner = 'live'; return 'person-owner' },
}))
vi.mock('@/lib/form-to-drive', () => ({
  saveFormToDrive: async (_t: string, _d: unknown, paths: string[], folderId: string, meta: { token: string; submittedAt: string }) => {
    st.companyCalls.push({ folderId, paths, token: meta.token, submittedAt: meta.submittedAt })
    return { summaryFileId: 'store:summary-1', copied: paths.map((p) => p.split('/').pop() as string), failed: [], skipped: [], errors: [] }
  },
}))
vi.mock('@/lib/crm-store/save-form', () => ({
  saveFormToStore: async (spec: { target: { kind: string; id: string }; uploadPaths: string[] }) => {
    st.personCalls.push({ target: spec.target, uploadPaths: spec.uploadPaths })
    return { summaryFileId: null, copied: spec.uploadPaths.map((p) => p.split('/').pop() as string), failed: [], skipped: [], errors: [] }
  },
}))
vi.mock('@/lib/forms/archive-enqueue', () => ({ enqueueFormArchiveJob: async (j: Record<string, unknown>) => { st.enqueued.push(j) } }))
vi.mock('@/lib/system-errors', () => ({ reportSystemError: async (e: { message: string }) => { st.alarms.push(e.message) } }))
vi.mock('@/lib/gmail', () => ({ gmailPost: async () => ({}) }))
vi.mock('@/lib/db', () => ({ dbWriteSafe: async () => ({}) }))
vi.mock('@/lib/operations/service-delivery', () => ({ advanceStageIfAt: async () => ({ advanced: false, reason: 'n/a', current_stage: null }) }))
vi.mock('@/lib/tasks/dispatch-workflow-for-event', () => ({ dispatchWorkflowForFormCompletion: async () => ({ spawned: true, workflow_slug: 'w', task_id: 't' }) }))

const PASSPORT = 'banking_relay/c1/passport_image_abc_front.jpg'
const PROOF = 'banking_relay/c1/proof_of_address_abc_bill.pdf'
const STATEMENT = 'banking_relay/c1/business_bank_statement_abc.pdf'

beforeEach(async () => {
  ;(await import('@/lib/crm-store/legacy-drive')).forgetRecentAlarms()
  ;(await import('@/lib/crm-store/throttled-alarm')).forgetThrottledAlarms()
  st.personOwner = 'live'; st.ensureNames.length = 0
  st.companyCalls.length = 0; st.personCalls.length = 0; st.enqueued.length = 0; st.alarms.length = 0; st.pilotAlarms.length = 0
  for (const k of Object.keys(st.rows)) delete st.rows[k]
  st.companyState = 'store'
  st.rows.banking_submissions = {
    id: 's1', token: 'tok', provider: 'relay', account_id: 'acc-1', contact_id: 'c1', status: 'completed', prefilled_data: { business_name: 'Acme LLC' },
    submitted_data: { business_name: 'Acme LLC' }, upload_paths: [PASSPORT, PROOF, STATEMENT], completed_at: '2026-10-18T14:30:00.000Z',
  }
  st.rows.accounts = { status: 'Active', drive_folder_id: null, gdrive_folder_url: null, company_name: 'Acme LLC' }
  st.rows.contacts = { full_name: 'Maria Rossi' }
  st.rows.store_owners = []
})

const post = async () => {
  const { POST } = await import('@/app/api/banking-form-completed/route')
  const res = await POST(new NextRequest('http://localhost/api/banking-form-completed', { method: 'POST', body: JSON.stringify({ submission_id: 's1', token: 'tok' }) }))
  const body = await res.json()
  return (body.results as Array<{ step: string; status: string; detail?: string }>).find((r) => r.step === 'save_to_drive')
}

describe('/api/banking-form-completed', () => {
  it('company in storage with NO Drive folder: business papers to the company, PERSONAL papers to the person, same day-stable key', async () => {
    const step = await post()
    expect(step?.status).toBe('ok')
    expect(st.companyCalls).toHaveLength(1)
    expect(st.companyCalls[0]).toMatchObject({ folderId: 'account-storage:acc-1', paths: [STATEMENT], token: 'tok' })
    expect(st.personCalls).toHaveLength(1)
    expect(st.personCalls[0]).toMatchObject({ target: { kind: 'contact', id: 'c1' }, uploadPaths: [PASSPORT, PROOF] })
    // fully filed: the marker the sweep keys on is set, and the durable job is NOT queued (nothing left to heal)
    expect(st.recorded.some((r) => r.table === 'banking_submissions' && r.op === 'update' && typeof (r.payload as Record<string, unknown>).drive_archived_at === 'string')).toBe(true)
    expect(st.enqueued).toEqual([])
  })
  it('a replay of the same POST files the very same thing (same key, same day-stable date) and does not add alarms', async () => {
    await post(); await post()
    expect(st.companyCalls[0].token).toBe(st.companyCalls[1].token)
    expect(st.companyCalls[0].submittedAt).toBe(st.companyCalls[1].submittedAt)
    expect(st.alarms).toEqual([])
  })
  it('no person linked: the personal papers are NOT filed in the company, ONE alarm, the step is an error', async () => {
    ;(st.rows.banking_submissions as Record<string, unknown>).contact_id = null
    const step = await post()
    expect(step?.status).toBe('error')
    expect(st.personCalls).toEqual([])
    expect(st.companyCalls[0].paths).toEqual([STATEMENT])
    expect(st.pilotAlarms).toEqual(['banking_package_problem'])
  })
  it('company moving (the REAL decision, not a mock): error, nothing filed, no alarm, and the durable job is queued (no pin: it works the destination out again when it runs)', async () => {
    st.companyState = 'moving'
    const step = await post()
    expect(step?.status).toBe('error')
    expect(step?.detail).toMatch(/retried/)
    expect(st.companyCalls).toEqual([]); expect(st.pilotAlarms).toEqual([])
    expect(st.enqueued[0]).toMatchObject({ formType: 'banking', submissionId: 's1' })
    expect(st.enqueued[0].pin).toBeUndefined()
  })
  it('PRIVACY: the person has only a hidden STUDY copy of their storage -> the personal papers are NOT filed (not into the study copy), ONE alarm, the company still gets its own files', async () => {
    st.personOwner = 'study'; st.rows.store_owners = [{ id: 'study-owner' }]
    const step = await post()
    expect(step?.status).toBe('error')
    expect(st.personCalls).toEqual([])
    expect(st.ensureNames).toEqual([])
    expect(st.companyCalls[0].paths).toEqual([STATEMENT])
    expect(st.pilotAlarms).toEqual(['banking_package_problem'])
    await post() // replayed: still told only once
    expect(st.pilotAlarms).toEqual(['banking_package_problem'])
  })
  it("a person with no storage yet gets one, named from the CRM contact's own name (never the company's)", async () => {
    st.personOwner = 'none'
    expect((await post())?.status).toBe('ok')
    expect(st.ensureNames).toEqual(['Maria Rossi'])
  })
  it('FAIL CLOSED: a new kind of KYC paper the code has never heard of goes to the person, never the company', async () => {
    const SELFIE = 'banking_relay/c1/selfie_with_id_abc.jpg', CERT = 'banking_relay/c1/tax_residency_certificate_abc.pdf'
    ;(st.rows.banking_submissions as Record<string, unknown>).upload_paths = [SELFIE, CERT, STATEMENT]
    await post()
    expect(st.companyCalls[0].paths).toEqual([STATEMENT])
    expect(st.personCalls[0].uploadPaths).toEqual([SELFIE, CERT])
  })
  it('a Closed company: error + ONE alarm even when the public endpoint is replayed many times; nothing filed, nothing queued', async () => {
    st.companyState = 'drive'; st.rows.accounts = { status: 'Closed', drive_folder_id: 'F-old', gdrive_folder_url: null, company_name: 'Acme LLC' }
    for (let i = 0; i < 5; i++) { const step = await post(); expect(step?.status).toBe('error') }
    expect(st.companyCalls).toEqual([]); expect(st.enqueued).toEqual([])
    expect(st.pilotAlarms).toEqual(['drive_write_refused'])
  })
})

describe('banking archive recipe (the sweep)', () => {
  it('a company in storage with no Drive folder resolves (no "NO drive_folder_id" throw); the filer decides the destination when the job runs', async () => {
    const { getArchiveRecipe } = await import('@/lib/forms/archive-registry')
    const plan = await getArchiveRecipe('banking')!.resolvePlan({ id: 's1', account_id: 'acc-1', provider: 'relay', upload_paths: [PASSPORT], submitted_data: {} } as never)
    expect(plan.folderId).toBeNull()
    expect(plan.configKey).toBe('banking_relay')
    expect(plan.uploadPaths).toEqual([PASSPORT])
  })
  it('a Closed company: the filer says so plainly (the job then fails loudly and the sweep alerts once)', async () => {
    st.companyState = 'drive'; st.rows.accounts = { status: 'Closed', drive_folder_id: 'F-old', gdrive_folder_url: null, company_name: 'Acme LLC' }
    const { fileBankingPackage } = await import('@/lib/forms/file-banking-package')
    const r = await fileBankingPackage({ flow: 'banking-archive', formType: 'banking_relay', accountId: 'acc-1', contactId: 'c1', submittedData: {}, uploadPaths: [], bucket: 'b', token: 't', folderId: null })
    expect(r.ok).toBe(false)
    expect(r.sentence).toMatch(/closed/)
  })
})

describe('a destination lookup that FAILS is not "no folder"', () => {
  it('the filer reports an error, alarms once, and asks for the durable job WITHOUT a pin', async () => {
    const { fileBankingPackage } = await import('@/lib/forms/file-banking-package')
    const alarms: string[] = []
    const r = await fileBankingPackage({
      flow: 'x', formType: 'banking', accountId: 'acc-1', contactId: 'c1', submittedData: {}, uploadPaths: [], bucket: 'b', token: 't',
    }, {
      destination: async () => { throw new Error('db down') },
      saveCompany: async () => { throw new Error('must not be called') }, savePerson: async () => { throw new Error('must not be called') },
      alarm: async (m) => { alarms.push(m) }, now: () => new Date(),
    })
    expect(r).toMatchObject({ ok: false, retryLater: true, enqueueUnpinned: true, pinFolderId: null })
    expect(r.errors[0]).toMatch(/db down/)
    expect(alarms).toHaveLength(1)
  })
})
