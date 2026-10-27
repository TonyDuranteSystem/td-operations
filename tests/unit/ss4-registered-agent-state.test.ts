/**
 * Dev job ff2b73d7 — a company's registered agent must be in the company's own state, and an SS-4 whose agent (or printed Line 6) is
 * not must never be created, sent to the client, re-sent, or faxed to the IRS.
 *
 * Real incident (2026-10-27): Tanto per is a New Mexico company; the Wyoming "Registered Agents Inc" address was linked to it by hand;
 * the SS-4 copied "Sheridan County, Wyoming" onto Line 6 and was faxed to the IRS that way.
 *
 * Covers: the pure rule, the server gate (fail-closed, stale-Line-6 repair for a re-send), the picker's save check, the send and
 * re-send routes, and SS-4 creation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const fx = vi.hoisted(() => ({
  sd: null as Record<string, unknown> | null,
  account: null as Record<string, unknown> | null,
  ss4: null as Record<string, unknown> | null,
  agent: null as Record<string, unknown> | null,
  contact: null as Record<string, unknown> | null,
  fail: { accounts: false, ss4: false, addresses: false },
  updates: [] as Array<{ table: string; values: Record<string, unknown> }>,
  inserts: [] as Array<{ table: string; values: Record<string, unknown> }>,
  logs: [] as Array<Record<string, unknown>>,
  notified: 0,
}))

function resolve(table: string, op: string) {
  if (op === 'update') return { data: [{ id: 'ss4-1' }], error: null }
  if (op === 'insert') return { data: { id: 'ss4-new', token: 'tok', access_code: 'code', status: 'draft' }, error: null }
  if (table === 'service_deliveries') return { data: fx.sd, error: null }
  if (table === 'accounts') return fx.fail.accounts ? { data: null, error: { message: 'boom' } } : { data: fx.account, error: null }
  if (table === 'ss4_applications') return fx.fail.ss4 ? { data: null, error: { message: 'boom' } } : { data: fx.ss4, error: null }
  if (table === 'addresses') return fx.fail.addresses ? { data: null, error: { message: 'boom' } } : { data: fx.agent, error: null }
  if (table === 'contacts') return { data: fx.contact, error: null }
  return { data: null, error: null }
}

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const state = { op: 'select' }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b: any = {}
      const chain = () => b
      b.select = chain; b.eq = chain; b.in = chain; b.is = chain; b.order = chain; b.limit = chain; b.like = chain; b.ilike = chain
      b.update = (values: Record<string, unknown>) => { state.op = 'update'; fx.updates.push({ table, values }); return b }
      b.insert = (values: Record<string, unknown>) => { state.op = 'insert'; fx.inserts.push({ table, values }); return b }
      b.maybeSingle = () => Promise.resolve(resolve(table, state.op))
      b.single = () => Promise.resolve(resolve(table, state.op))
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(resolve(table, state.op)).then(res, rej)
      return b
    },
  },
}))
vi.mock('@/lib/auth/require-staff-route', () => ({ requireStaffRoute: async () => null }))
vi.mock('@/lib/mcp/action-log', () => ({ logAction: (a: Record<string, unknown>) => { fx.logs.push(a); return Promise.resolve() } }))
vi.mock('@/lib/portal/action-required', () => ({ notifySs4ReadyToSign: async () => { fx.notified++; return { chat: true } } }))
vi.mock('@/lib/operations/ss4-refresh', () => ({
  assertSs4PartyPromotable: async () => ({ ok: true }),
  resolveMailing: () => ({ street: '10225 Ulmerton Rd 3D', cityStateZip: 'Largo, FL 33771' }),
}))

import {
  stateCode, stateLabel, line6State, checkAgentInCompanyState, checkLine6InCompanyState,
} from '@/lib/formation/registered-agent-state'
import { checkSs4StateGate, registeredAgentStateProblem } from '@/lib/operations/ss4-state-gate'
import { POST as sendSs4 } from '@/app/api/flows/[id]/send-ss4/route'
import { POST as resendSs4 } from '@/app/api/flows/[id]/resend-ss4/route'
import { createSS4 } from '@/lib/operations/ss4'

const NM_ACCOUNT = { id: 'acc-1', company_name: 'Tanto per LLC', state_of_formation: 'New Mexico', registered_agent_id: 'ra-1', entity_type: 'Single Member LLC', formation_date: '2026-10-20', physical_address: null, suite_number: null, mailing_address: null }
const WY_AGENT = { state: 'WY', county: 'Sheridan' }
const NM_AGENT = { state: 'NM', county: 'Bernalillo' }

beforeEach(() => {
  fx.sd = { account_id: 'acc-1', service_type: 'Company Formation' }
  fx.account = { ...NM_ACCOUNT }
  fx.ss4 = { id: 'ss4-1', status: 'draft', company_name: 'Tanto per LLC', county_and_state: 'Bernalillo County, New Mexico', contact_id: 'c-1', entity_type: 'SMLLC', responsible_party_name: 'Alessandro' }
  fx.agent = { ...NM_AGENT }
  fx.contact = { id: 'c-1', full_name: 'Alessandro', itin_number: null, phone: null, language: 'English' }
  fx.fail = { accounts: false, ss4: false, addresses: false }
  fx.updates = []
  fx.inserts = []
  fx.logs = []
  fx.notified = 0
})

// ── the pure rule ────────────────────────────────────────────────────────────

describe('stateCode / stateLabel — spelling never matters', () => {
  it('reads full names, codes, lower case, dots and spacing', () => {
    expect(stateCode('New Mexico')).toBe('NM')
    expect(stateCode('NM')).toBe('NM')
    expect(stateCode(' nm ')).toBe('NM')
    expect(stateCode('N.M.')).toBe('NM')
    expect(stateCode('wyoming')).toBe('WY')
    expect(stateCode('New  Hampshire')).toBe('NH')
    expect(stateCode('Washington DC')).toBe('DC')
  })
  it('is null for blank or unknown text — never a guess', () => {
    expect(stateCode('')).toBeNull()
    expect(stateCode(null)).toBeNull()
    expect(stateCode(undefined)).toBeNull()
    expect(stateCode('Narnia')).toBeNull()
    expect(stateCode('N')).toBeNull()
  })
  it('names a state in plain English', () => {
    expect(stateLabel('WY')).toBe('Wyoming')
    expect(stateLabel('New Mexico')).toBe('New Mexico')
    expect(stateLabel('Narnia')).toBe('Narnia')
    expect(stateLabel(null)).toBe('an unknown state')
  })
})

describe('line6State', () => {
  it('reads what follows the last comma — and the one older "county - state" row', () => {
    expect(line6State('Sheridan County, Wyoming')).toBe('WY')
    expect(line6State('Pinellas County, Florida')).toBe('FL')
    expect(line6State('Bernalillo County, New Mexico')).toBe('NM')
    expect(line6State('Bernalillo - New Mexico')).toBe('NM')
    expect(line6State('Sheridan County, WY')).toBe('WY')
  })
  it('is null when the state cannot be read', () => {
    expect(line6State('Sheridan County')).toBeNull()
    expect(line6State('County, Narnia')).toBeNull()
    expect(line6State('')).toBeNull()
    expect(line6State(null)).toBeNull()
  })
})

describe('checkAgentInCompanyState', () => {
  it('passes when the agent is in the company state, whatever the spelling ("New Mexico" vs "NM")', () => {
    expect(checkAgentInCompanyState({ companyState: 'New Mexico', agentState: 'NM' }).ok).toBe(true)
    expect(checkAgentInCompanyState({ companyState: 'NM', agentState: 'New Mexico' }).ok).toBe(true)
  })
  it('THE TANTO PER CASE: a New Mexico company with the Wyoming agent is refused, in plain words naming both states and the company', () => {
    const r = checkAgentInCompanyState({ companyState: 'New Mexico', agentState: 'WY', companyName: 'Tanto per LLC' })
    expect(r.ok).toBe(false)
    expect(r.problem).toBe('mismatch')
    expect(r.message).toContain('Tanto per LLC')
    expect(r.message).toContain('in Wyoming')
    expect(r.message).toContain('formed in New Mexico')
    expect(r.message).toContain('Pick a New Mexico registered agent')
  })
  it('an unknown company state or an unreadable agent state is refused, never passed', () => {
    expect(checkAgentInCompanyState({ companyState: null, agentState: 'NM' }).problem).toBe('company_state_unknown')
    expect(checkAgentInCompanyState({ companyState: 'NM', agentState: '' }).problem).toBe('agent_state_unknown')
    expect(checkAgentInCompanyState({ companyState: 'Narnia', agentState: 'NM' }).problem).toBe('company_state_unknown')
  })
})

describe('checkLine6InCompanyState — what the IRS actually reads', () => {
  it('passes when Line 6 carries the company state', () => {
    expect(checkLine6InCompanyState({ companyState: 'NM', line6: 'Bernalillo County, New Mexico' }).ok).toBe(true)
  })
  it('refuses a Line 6 in another state', () => {
    const r = checkLine6InCompanyState({ companyState: 'New Mexico', line6: 'Sheridan County, Wyoming', companyName: 'Tanto per LLC' })
    expect(r.ok).toBe(false)
    expect(r.message).toContain('Line 6 of this SS-4 says Wyoming')
    expect(r.message).toContain('formed in New Mexico')
  })
  it('refuses a Line 6 whose state cannot be read, and says how it must look', () => {
    const r = checkLine6InCompanyState({ companyState: 'NM', line6: 'Bernalillo' })
    expect(r.ok).toBe(false)
    expect(r.message).toContain('must end with the state')
  })
})

// ── the server gate ──────────────────────────────────────────────────────────

describe('checkSs4StateGate', () => {
  it('all consistent → ok, nothing to fix', async () => {
    const g = await checkSs4StateGate('acc-1', { context: 'fax' })
    expect(g.ok).toBe(true)
    expect(g.line6Fix).toBeNull()
  })

  it('the agent is in the wrong state → refused, with the next step for each place it is used', async () => {
    fx.agent = { ...WY_AGENT }
    const send = await checkSs4StateGate('acc-1', { context: 'send' })
    expect(send.ok).toBe(false)
    expect(send.kind).toBe('agent')
    expect(send.message).toContain('in Wyoming')
    expect(send.message).toContain('Regenerate from account data')
    const resend = await checkSs4StateGate('acc-1', { context: 'resend' })
    expect(resend.message).toContain('re-send the SS-4 for signature')
    const fax = await checkSs4StateGate('acc-1', { context: 'fax' })
    expect(fax.message).toContain('Nothing was faxed')
    expect(fax.message).toContain('Re-send for Signature')
  })

  it('agent now right but the saved Line 6 still says Wyoming: refused strictly (fax / send)…', async () => {
    fx.ss4 = { ...fx.ss4, county_and_state: 'Sheridan County, Wyoming' }
    const fax = await checkSs4StateGate('acc-1', { context: 'fax' })
    expect(fax.ok).toBe(false)
    expect(fax.kind).toBe('line6')
    expect(fax.message).toContain('Line 6 of this SS-4 says Wyoming')
    expect(fax.message).toContain('Nothing was faxed')
  })

  it('…but for a RE-SEND the gate hands back the corrected Line 6 (a signed SS-4 cannot be refreshed in place)', async () => {
    fx.ss4 = { ...fx.ss4, county_and_state: 'Sheridan County, Wyoming' }
    const g = await checkSs4StateGate('acc-1', { context: 'resend', allowStaleLine6: true })
    expect(g.ok).toBe(true)
    expect(g.line6Fix).toBe('Bernalillo County, New Mexico')
  })

  it('a stale Line 6 cannot be repaired when the agent has no county — refused even for a re-send', async () => {
    fx.ss4 = { ...fx.ss4, county_and_state: 'Sheridan County, Wyoming' }
    fx.agent = { state: 'NM', county: null }
    const g = await checkSs4StateGate('acc-1', { context: 'resend', allowStaleLine6: true })
    expect(g.ok).toBe(false)
    expect(g.kind).toBe('line6')
  })

  it('a wrong-state agent is never "repaired" for a re-send — the agent is the problem', async () => {
    fx.ss4 = { ...fx.ss4, county_and_state: 'Sheridan County, Wyoming' }
    fx.agent = { ...WY_AGENT }
    const g = await checkSs4StateGate('acc-1', { context: 'resend', allowStaleLine6: true })
    expect(g.ok).toBe(false)
    expect(g.kind).toBe('agent')
  })

  it('a hand-typed Line 6 (ss4_update) is caught through the override, and a correct override beats a stale stored one', async () => {
    const bad = await checkSs4StateGate('acc-1', { context: 'send', line6Override: 'Sheridan County, Wyoming' })
    expect(bad.ok).toBe(false)
    expect(bad.kind).toBe('line6')
    fx.ss4 = { ...fx.ss4, county_and_state: 'Sheridan County, Wyoming' }
    const good = await checkSs4StateGate('acc-1', { context: 'send', line6Override: 'Bernalillo County, New Mexico' })
    expect(good.ok).toBe(true)
  })

  it('spelling differences never block: the company says "NM", the agent "New Mexico"', async () => {
    fx.account = { ...NM_ACCOUNT, state_of_formation: 'NM' }
    fx.agent = { state: 'New Mexico', county: 'Bernalillo' }
    expect((await checkSs4StateGate('acc-1', { context: 'send' })).ok).toBe(true)
  })

  it('a blank Line 6 is not this gate\'s job (the send and signing steps already refuse it); no agent linked + matching Line 6 passes', async () => {
    fx.ss4 = { ...fx.ss4, county_and_state: null }
    expect((await checkSs4StateGate('acc-1', { context: 'send' })).ok).toBe(true)
    fx.ss4 = { ...fx.ss4, county_and_state: 'Bernalillo County, New Mexico' }
    fx.account = { ...NM_ACCOUNT, registered_agent_id: null }
    expect((await checkSs4StateGate('acc-1', { context: 'fax' })).ok).toBe(true)
  })

  it('an unknown company state refuses the SS-4', async () => {
    fx.account = { ...NM_ACCOUNT, state_of_formation: null }
    const g = await checkSs4StateGate('acc-1', { context: 'send' })
    expect(g.ok).toBe(false)
    expect(g.message).toContain('state')
  })

  it('FAILS CLOSED: a record that cannot be read is a refusal ("nothing was sent"), never a pass', async () => {
    fx.fail.accounts = true
    const a = await checkSs4StateGate('acc-1', { context: 'fax' })
    expect(a.ok).toBe(false)
    expect(a.kind).toBe('read_error')
    expect(a.message).toContain('Nothing was sent')
    fx.fail = { accounts: false, ss4: true, addresses: false }
    expect((await checkSs4StateGate('acc-1', { context: 'fax' })).kind).toBe('read_error')
    fx.fail = { accounts: false, ss4: false, addresses: true }
    expect((await checkSs4StateGate('acc-1', { context: 'fax' })).kind).toBe('read_error')
    fx.fail = { accounts: false, ss4: false, addresses: false }
    fx.account = null
    expect((await checkSs4StateGate('acc-1', { context: 'fax' })).kind).toBe('read_error')
  })
})

// ── the picker's save ────────────────────────────────────────────────────────

describe('registeredAgentStateProblem — linking an agent to a company', () => {
  it('refuses the Wyoming agent on a New Mexico company', async () => {
    fx.agent = { ...WY_AGENT }
    const p = await registeredAgentStateProblem('acc-1', 'ra-wy')
    expect(p).toContain('in Wyoming')
    expect(p).toContain('formed in New Mexico')
  })
  it('allows the right-state agent', async () => {
    fx.agent = { ...NM_AGENT }
    expect(await registeredAgentStateProblem('acc-1', 'ra-nm')).toBeNull()
  })
  it('allows any agent while the company has no state yet (nothing to compare; the SS-4 gates refuse it later)', async () => {
    fx.account = { ...NM_ACCOUNT, state_of_formation: null }
    fx.agent = { ...WY_AGENT }
    expect(await registeredAgentStateProblem('acc-1', 'ra-wy')).toBeNull()
  })
  it('refuses an agent entry whose own state is blank or unreadable', async () => {
    fx.agent = { state: '', county: 'Bernalillo' }
    expect(await registeredAgentStateProblem('acc-1', 'ra-x')).toContain('no state')
  })
  it('a check that cannot be completed saves nothing', async () => {
    fx.fail.addresses = true
    expect(await registeredAgentStateProblem('acc-1', 'ra-x')).toContain('Nothing was saved')
    fx.fail = { accounts: true, ss4: false, addresses: false }
    expect(await registeredAgentStateProblem('acc-1', 'ra-x')).toContain('Nothing was saved')
  })
})

// ── the send and re-send routes ──────────────────────────────────────────────

const call = (route: typeof sendSs4) =>
  route(new NextRequest('http://localhost/api/flows/sd-1/x', { method: 'POST' }), { params: { id: 'sd-1' } })

describe('send-ss4 route', () => {
  it('REFUSES to send the client an SS-4 whose registered agent is in the wrong state (409, plain reason, nothing written, nobody notified)', async () => {
    fx.agent = { ...WY_AGENT }
    fx.ss4 = { ...fx.ss4, county_and_state: 'Sheridan County, Wyoming' }
    const res = await call(sendSs4)
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.error).toContain('in Wyoming')
    expect(fx.updates.filter((u) => u.table === 'ss4_applications')).toHaveLength(0)
    expect(fx.notified).toBe(0)
  })

  it('refuses when the agent is right but the saved Line 6 is stale, and points at Regenerate', async () => {
    fx.ss4 = { ...fx.ss4, county_and_state: 'Sheridan County, Wyoming' }
    const res = await call(sendSs4)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toContain('Regenerate from account data')
    expect(fx.notified).toBe(0)
  })

  it('a check that cannot be completed is a 503 and nothing is sent', async () => {
    fx.fail.addresses = true
    const res = await call(sendSs4)
    expect(res.status).toBe(503)
    expect(fx.notified).toBe(0)
  })

  it('a consistent SS-4 is still sent as before', async () => {
    const res = await call(sendSs4)
    expect(res.status).toBe(200)
    expect(fx.updates.some((u) => u.table === 'ss4_applications' && u.values.status === 'awaiting_signature')).toBe(true)
    expect(fx.notified).toBe(1)
  })
})

describe('resend-ss4 route (signed SS-4 → back to the client)', () => {
  beforeEach(() => {
    fx.ss4 = { ...fx.ss4, status: 'signed', county_and_state: 'Sheridan County, Wyoming' }
  })

  it('REFUSES while the registered agent is still in the wrong state — the client is not asked to sign again', async () => {
    fx.agent = { ...WY_AGENT }
    const res = await call(resendSs4)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toContain('in Wyoming')
    expect(fx.updates.filter((u) => u.table === 'ss4_applications')).toHaveLength(0)
    expect(fx.notified).toBe(0)
  })

  it('THE TANTO PER FIX PATH: agent corrected to New Mexico → the re-open CORRECTS Line 6 in the same update, logs it, and the client signs the corrected form', async () => {
    fx.agent = { ...NM_AGENT }
    const res = await call(resendSs4)
    expect(res.status).toBe(200)
    const upd = fx.updates.find((u) => u.table === 'ss4_applications')
    expect(upd?.values.status).toBe('awaiting_signature')
    expect(upd?.values.signature_data).toBeNull()
    expect(upd?.values.county_and_state).toBe('Bernalillo County, New Mexico')
    const log = fx.logs.find((l) => (l.details as Record<string, unknown> | undefined)?.source === 'flow-resend-ss4')
    expect((log?.details as Record<string, unknown>).line_6_corrected_to).toBe('Bernalillo County, New Mexico')
    expect((log?.details as Record<string, unknown>).line_6_was).toBe('Sheridan County, Wyoming')
    expect(fx.notified).toBe(1)
  })

  it('an SS-4 whose Line 6 is already right is re-opened without touching Line 6', async () => {
    fx.ss4 = { ...fx.ss4, county_and_state: 'Bernalillo County, New Mexico' }
    const res = await call(resendSs4)
    expect(res.status).toBe(200)
    const upd = fx.updates.find((u) => u.table === 'ss4_applications')
    expect('county_and_state' in (upd?.values ?? {})).toBe(false)
  })

  it('cannot repair Line 6 (agent has no county) → refused', async () => {
    fx.agent = { state: 'NM', county: null }
    const res = await call(resendSs4)
    expect(res.status).toBe(409)
    expect(fx.updates.filter((u) => u.table === 'ss4_applications')).toHaveLength(0)
  })
})

// ── SS-4 creation ────────────────────────────────────────────────────────────

describe('createSS4', () => {
  beforeEach(() => {
    fx.ss4 = null // no SS-4 yet
  })

  it('REFUSES to create the SS-4 when the agent is in the wrong state — no row is inserted', async () => {
    fx.agent = { ...WY_AGENT }
    const r = await createSS4({ account_id: 'acc-1', contact_id: 'c-1', entity_type: 'SMLLC' })
    expect(r.ok).toBe(false)
    expect(r.outcome).toBe('ra_state_mismatch')
    expect(r.message).toContain('in Wyoming')
    expect(r.message).toContain('formed in New Mexico')
    expect(fx.inserts.filter((i) => i.table === 'ss4_applications')).toHaveLength(0)
  })

  it('names the state problem before a missing county', async () => {
    fx.agent = { state: 'WY', county: null }
    const r = await createSS4({ account_id: 'acc-1', contact_id: 'c-1', entity_type: 'SMLLC' })
    expect(r.outcome).toBe('ra_state_mismatch')
  })

  it('creates the SS-4 for a right-state agent, with Line 6 from that agent', async () => {
    fx.agent = { ...NM_AGENT }
    const r = await createSS4({ account_id: 'acc-1', contact_id: 'c-1', entity_type: 'SMLLC' })
    expect(r.ok).toBe(true)
    const ins = fx.inserts.find((i) => i.table === 'ss4_applications')
    expect(ins?.values.county_and_state).toBe('Bernalillo County, New Mexico')
  })
})
