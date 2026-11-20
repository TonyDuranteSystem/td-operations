import { describe, it, expect, vi, beforeEach } from 'vitest'

// Scripted fake of the database: each .from(table) chain records its filters and answers from `answers`.
const { state, getUser, resolveIdentity, getDecision, respond, canAccess, getService } = vi.hoisted(() => ({
  state: { ops: [] as Array<{ table: string; op: string; payload?: unknown; filters: Array<[string, unknown]> }>, answers: {} as Record<string, unknown> },
  getUser: vi.fn(),
  resolveIdentity: vi.fn(),
  getDecision: vi.fn(),
  respond: vi.fn(),
  canAccess: vi.fn(),
  getService: vi.fn(),
}))

function chain(table: string, op: string, payload?: unknown) {
  const rec = { table, op, payload, filters: [] as Array<[string, unknown]> }
  state.ops.push(rec)
  const result = () => state.answers[`${table}:${op}`] ?? { data: null, error: null }
  const c: Record<string, unknown> = {}
  for (const m of ['select', 'not', 'is', 'in', 'order', 'limit']) c[m] = () => c
  c.eq = (col: string, v: unknown) => { rec.filters.push([col, v]); return c }
  c.maybeSingle = async () => result()
  c.single = async () => result()
  c.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result()).then(res, rej)
  return c
}

vi.mock('@/lib/supabase/server', () => ({ createClient: () => ({ auth: { getUser } }) }))
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: { from: (table: string) => ({ select: () => chain(table, 'select'), insert: (p: unknown) => chain(table, 'insert', p), update: (p: unknown) => chain(table, 'update', p) }) },
}))
vi.mock('@/lib/portal/resolve-portal-identity', () => ({ resolvePortalIdentity: resolveIdentity }))
vi.mock('@/lib/operations/decision-request', () => ({ getDecisionRequest: getDecision, respondToDecisionRequest: respond }))
vi.mock('@/lib/portal/team/gate', () => ({ canAccessAccount: canAccess }))
vi.mock('@/lib/services', () => ({ getServiceBySlug: getService }))
vi.mock('@/lib/portal/wizard-progress-write', () => ({ createOrReuseWizardProgress: vi.fn() }))
vi.mock('@/lib/portal/formation-lead-access', () => ({ formationLeadOwned: vi.fn(), formationOfferOwned: vi.fn(), onboardingOfferOwned: vi.fn() }))
vi.mock('@/lib/portal/closure-subject', () => ({ verifyClosureServiceDelivery: vi.fn() }))

import { POST as wizardProgress } from '@/app/api/portal/wizard-progress/route'
import { POST as serviceRequest } from '@/app/api/portal/service-request/route'
import { POST as decisionRespond } from '@/app/api/portal/decisions/[id]/respond/route'

const teamLogin = { id: 'u-team', email: 'tm-x@teammate.portal.tonydurante.us', app_metadata: { role: 'client', kind: 'team_member', account_id: 'ACC-X' }, user_metadata: {} }
const clientLogin = { id: 'u-client', email: 'c@example.com', app_metadata: { role: 'client', contact_id: 'C-OWN' }, user_metadata: {} }
const team = (caps: Record<string, boolean>) => ({ kind: 'teammate', teamMemberId: 'tm1', accountId: 'ACC-X', displayName: 'T', email: null, capabilities: caps })
const req = (body: unknown) => ({ json: async () => body }) as unknown as import('next/server').NextRequest

beforeEach(() => {
  vi.clearAllMocks()
  state.ops = []
  state.answers = {}
})

describe('wizard-progress: updating a draft by id', () => {
  const update = (savedType: string, over: Record<string, unknown> = {}) => {
    state.answers['wizard_progress:select'] = { data: { id: 'p1', account_id: 'ACC-X', contact_id: null, lead_id: null, offer_id: null, wizard_type: savedType, ...over }, error: null }
  }
  const body = { wizard_type: 'banking_payset', progress_id: 'p1', data: { x: 1 }, current_step: 1 }
  const wrote = () => state.ops.some(o => o.table === 'wizard_progress' && o.op === 'update')

  it('a bank-tick team login CAN update its own bank draft', async () => {
    getUser.mockResolvedValue({ data: { user: teamLogin } })
    resolveIdentity.mockResolvedValue(team({ bank_applications: true }))
    update('banking_payset')
    const res = await wizardProgress(req(body))
    expect(res.status).toBe(200)
    expect(wrote()).toBe(true)
  })
  it('REFUSES a draft of ANOTHER form in the same company (it names the bank type but the draft is a tax draft)', async () => {
    getUser.mockResolvedValue({ data: { user: teamLogin } })
    resolveIdentity.mockResolvedValue(team({ bank_applications: true }))
    update('tax')
    const res = await wizardProgress(req(body))
    expect(res.status).toBe(403)
    expect(wrote()).toBe(false)
  })
  it('REFUSES an owner\'s personal draft that carries no company (e.g. an ITIN draft)', async () => {
    getUser.mockResolvedValue({ data: { user: teamLogin } })
    resolveIdentity.mockResolvedValue(team({ bank_applications: true }))
    update('banking_payset', { account_id: null, contact_id: 'C-OWNER' })
    const res = await wizardProgress(req(body))
    expect(res.status).toBe(403)
    expect(wrote()).toBe(false)
  })
  it('REFUSES a draft of another company', async () => {
    getUser.mockResolvedValue({ data: { user: teamLogin } })
    resolveIdentity.mockResolvedValue(team({ bank_applications: true }))
    update('banking_payset', { account_id: 'ACC-OTHER' })
    expect((await wizardProgress(req(body))).status).toBe(403)
  })
  it('a normal client updating their own draft is unchanged, even when the form type differs from the saved one', async () => {
    getUser.mockResolvedValue({ data: { user: clientLogin } })
    resolveIdentity.mockResolvedValue({ kind: 'contact', contactId: 'C-OWN', accountIds: ['ACC-X'] })
    update('tax')
    expect((await wizardProgress(req({ ...body, wizard_type: 'company_info' }))).status).toBe(200)
  })
})

describe('service-request', () => {
  const ok = { service_id: 'itin', details: 'please', urgency: 'normal' }
  beforeEach(() => {
    getService.mockResolvedValue({ display_name: 'ITIN' })
    state.answers['account_contacts:select'] = { data: [{ account_id: 'ACC-OWN', accounts: { company_name: 'Own LLC' } }], error: null }
    state.answers['contacts:select'] = { data: { full_name: 'Own Person', email: 'own@example.com' }, error: null }
    state.answers['tasks:insert'] = { data: { id: 't1' }, error: null }
  })
  it('a team login WITHOUT the "Can ask for new services" tick can NOT ask, however many other ticks it holds', async () => {
    getUser.mockResolvedValue({ data: { user: teamLogin } })
    resolveIdentity.mockResolvedValue(team({ documents: true, chat: true, invoices_billing: true, company_forms: true, answer_decisions: true }))
    const res = await serviceRequest(req(ok))
    expect(res.status).toBe(403)
    expect(state.ops.some(o => o.table === 'tasks')).toBe(false)
  })
  it('a team login WITH the tick can: filed under ITS company, by name, never under any contact', async () => {
    getUser.mockResolvedValue({ data: { user: teamLogin } })
    resolveIdentity.mockResolvedValue({ ...team({ chat: true, request_services: true }), displayName: 'Anna Rossi' })
    state.answers['accounts:select'] = { data: { company_name: 'Acme LLC' }, error: null }
    const res = await serviceRequest(req({ ...ok, contact_id: 'C-SOMEONE-ELSE' }))
    expect(res.status).toBe(200)
    const task = state.ops.find(o => o.table === 'tasks' && o.op === 'insert')!
    expect(task.payload).toMatchObject({ account_id: 'ACC-X', contact_id: null })
    const text = JSON.stringify(task.payload)
    expect(text).toContain('Anna Rossi (team member)')
    expect(text).toContain('Acme LLC')
    expect(text).not.toContain('teammate.portal.tonydurante.us')
    expect(text).not.toContain('C-SOMEONE-ELSE')
    expect(state.ops.some(o => o.table === 'account_contacts')).toBe(false)
  })
  it('a client files under THEIR OWN contact, whatever contact_id the request names', async () => {
    getUser.mockResolvedValue({ data: { user: clientLogin } })
    await serviceRequest(req({ ...ok, contact_id: 'C-SOMEONE-ELSE' }))
    const link = state.ops.find(o => o.table === 'account_contacts')!
    expect(link.filters).toContainEqual(['contact_id', 'C-OWN'])
    expect(state.ops.some(o => o.filters.some(([, v]) => v === 'C-SOMEONE-ELSE'))).toBe(false)
    const task = state.ops.find(o => o.table === 'tasks' && o.op === 'insert')!
    expect(task.payload).toMatchObject({ contact_id: 'C-OWN', account_id: 'ACC-OWN' })
  })
})

describe('decisions: answering', () => {
  const params = { params: { id: 'd1' } }
  beforeEach(() => {
    getDecision.mockResolvedValue({ id: 'd1', account_id: 'ACC-X', contact_id: null })
    canAccess.mockResolvedValue(true)
    respond.mockResolvedValue({ ok: true, status: 'answered', auto_advanced: false })
  })
  it('a team login with only the Documents tick can see decisions but NOT answer them', async () => {
    getUser.mockResolvedValue({ data: { user: teamLogin } })
    canAccess.mockImplementation(async (_u: unknown, _a: string, cap: string) => cap === 'documents')
    const res = await decisionRespond(req({ response: { choice: 'a' } }), params)
    expect(res.status).toBe(403)
    expect(respond).not.toHaveBeenCalled()
  })
  it('a team login WITH the "Can answer client decisions" tick can', async () => {
    getUser.mockResolvedValue({ data: { user: teamLogin } })
    canAccess.mockImplementation(async (_u: unknown, _a: string, cap: string) => cap === 'answer_decisions')
    const res = await decisionRespond(req({ response: { choice: 'a' } }), params)
    expect(res.status).toBe(200)
    expect(respond).toHaveBeenCalledTimes(1)
  })
  it('an owner or member of the company still can', async () => {
    getUser.mockResolvedValue({ data: { user: clientLogin } })
    const res = await decisionRespond(req({ response: { choice: 'a' } }), params)
    expect(res.status).toBe(200)
    expect(respond).toHaveBeenCalled()
  })
  it('a client still answers a decision addressed to their own contact', async () => {
    getUser.mockResolvedValue({ data: { user: clientLogin } })
    getDecision.mockResolvedValue({ id: 'd1', account_id: null, contact_id: 'C-OWN' })
    canAccess.mockResolvedValue(false)
    expect((await decisionRespond(req({ response: {} }), params)).status).toBe(200)
  })
})
