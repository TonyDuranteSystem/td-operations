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
  liveOwnerOfContact: async () => 'person-owner',
}))
vi.mock('@/lib/crm-store/formation-pilot', () => ({
  raisePilotAlarm: async (kind: string) => { st.pilotAlarms.push(kind) },
  ensurePersonOwner: async () => 'person-owner',
}))
vi.mock('@/lib/crm-store/lead-form-store', () => ({ storageDestinationForForm: async (i: { accountId: string }) => ({ marker: st.companyState === 'store' ? `account-storage:${i.accountId}` : null }) }))
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
  st.companyCalls.length = 0; st.personCalls.length = 0; st.enqueued.length = 0; st.alarms.length = 0; st.pilotAlarms.length = 0
  for (const k of Object.keys(st.rows)) delete st.rows[k]
  st.companyState = 'store'
  st.rows.banking_submissions = {
    id: 's1', token: 'tok', provider: 'relay', account_id: 'acc-1', contact_id: 'c1', status: 'completed', prefilled_data: { business_name: 'Acme LLC' },
    submitted_data: { business_name: 'Acme LLC' }, upload_paths: [PASSPORT, PROOF, STATEMENT], completed_at: '2026-10-18T14:30:00.000Z',
  }
  st.rows.accounts = { status: 'Active', drive_folder_id: null, gdrive_folder_url: null, company_name: 'Acme LLC' }
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
    expect(st.enqueued[0]).toMatchObject({ formType: 'banking', pin: { folderId: 'account-storage:acc-1' } })
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
    expect(st.alarms).toHaveLength(1)
  })
  it('company moving: error, and the durable job is STILL queued (pinned to the storage) so it can heal', async () => {
    st.companyState = 'moving'
    const step = await post()
    expect(step?.status).toBe('error')
    expect(step?.detail).toMatch(/retried/)
    expect(st.companyCalls).toEqual([])
    expect(st.enqueued[0]).toMatchObject({ pin: { folderId: 'account-storage:acc-1' } })
  })
  it('a Closed company: error + ONE alarm even when the public endpoint is replayed many times; nothing filed, nothing queued', async () => {
    st.companyState = 'drive'; st.rows.accounts = { status: 'Closed', drive_folder_id: 'F-old', gdrive_folder_url: null, company_name: 'Acme LLC' }
    for (let i = 0; i < 5; i++) { const step = await post(); expect(step?.status).toBe('error') }
    expect(st.companyCalls).toEqual([]); expect(st.enqueued).toEqual([])
    expect(st.pilotAlarms).toEqual(['drive_write_refused'])
  })
})

describe('banking archive recipe (the sweep)', () => {
  it('a company in storage with no Drive folder resolves to its storage instead of throwing "NO drive_folder_id"', async () => {
    const { getArchiveRecipe } = await import('@/lib/forms/archive-registry')
    const plan = await getArchiveRecipe('banking')!.resolvePlan({ id: 's1', account_id: 'acc-1', provider: 'relay', upload_paths: [PASSPORT], submitted_data: {} } as never)
    expect(plan.folderId).toBe('account-storage:acc-1')
    expect(plan.configKey).toBe('banking_relay')
  })
  it('a company that cannot be filed for says so plainly', async () => {
    st.companyState = 'drive'; st.rows.accounts = { status: 'Closed', drive_folder_id: 'F-old', gdrive_folder_url: null, company_name: 'Acme LLC' }
    const { getArchiveRecipe } = await import('@/lib/forms/archive-registry')
    await expect(getArchiveRecipe('banking')!.resolvePlan({ id: 's1', account_id: 'acc-1', provider: 'relay', upload_paths: [], submitted_data: {} } as never)).rejects.toThrow(/nowhere to be filed/)
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
