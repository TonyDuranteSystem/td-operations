/**
 * Dev job ff2b73d7 — the LAST gate: the fax to the IRS. An SS-4 whose registered agent (or printed Line 6) is not in the company's own
 * state must never be faxed (Tanto per: a New Mexico company faxed with "Sheridan County, Wyoming"). The gate runs for the SS-4 panel
 * (its double-send guard flag) and for any send of a stored SS-4 document, BEFORE anything is claimed or sent, and fails closed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const fx = vi.hoisted(() => ({
  sd: null as Record<string, unknown> | null,
  account: null as Record<string, unknown> | null,
  ss4: null as Record<string, unknown> | null,
  agent: null as Record<string, unknown> | null,
  doc: null as Record<string, unknown> | null,
  fail: { sd: false, accounts: false, doc: false },
  sendCalls: 0,
}))

vi.mock('@/lib/supabase/server', () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1', email: 'luca@tonydurante.us', app_metadata: { role: 'team' } } } }) } }) }))
vi.mock('@/lib/auth', () => ({ isDashboardUser: () => true, isOwnerOnly: () => false }))
vi.mock('@/lib/google-drive', () => ({ downloadFileBinary: async () => { throw new Error('Drive must not be used') } }))
vi.mock('@/lib/fax/faxage', () => ({
  isProvablyNotSent: () => false,
  sendFax: async () => { fx.sendCalls++; return { ok: true, outcome: 'accepted', jobId: 'J1', raw: 'ok' } },
  isValidFaxNo: (x: string) => String(x).replace(/\D/g, '').length >= 10,
  normalizeFaxNo: (x: string) => x,
  DEFAULT_IRS_FAX_NUMBER: '8556416935',
  stripBase64Prefix: (b: string) => b,
}))
vi.mock('@/lib/system-errors', () => ({ reportSystemError: async () => {} }))
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b: any = {}
      const chain = () => b
      b.select = chain; b.eq = chain; b.in = chain; b.order = chain; b.limit = chain; b.is = chain; b.gte = chain
      const one = () => {
        if (table === 'service_deliveries') return fx.fail.sd ? { data: null, error: { message: 'boom' } } : { data: fx.sd, error: null }
        if (table === 'accounts') return fx.fail.accounts ? { data: null, error: { message: 'boom' } } : { data: fx.account, error: null }
        if (table === 'ss4_applications') return { data: fx.ss4, error: null }
        if (table === 'addresses') return { data: fx.agent, error: null }
        if (table === 'documents') return fx.fail.doc ? { data: null, error: { message: 'boom' } } : { data: fx.doc, error: null }
        return { data: null, error: null } // action_log (no earlier fax), anything else
      }
      b.maybeSingle = () => Promise.resolve(one())
      b.single = () => Promise.resolve(one())
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(one()).then(res, rej)
      return b
    },
    storage: { from: () => ({ remove: async () => ({ data: null, error: null }) }) },
  },
}))

import { POST } from '@/app/api/tools/fax/send/route'

const NM_ACCOUNT = { company_name: 'Tanto per LLC', state_of_formation: 'New Mexico', registered_agent_id: 'ra-1' }

const send = (body: Record<string, unknown>) =>
  POST(new NextRequest('http://localhost/api/tools/fax/send', { method: 'POST', body: JSON.stringify({ faxno: '8556416935', recip_name: 'IRS', ...body }) }))

beforeEach(() => {
  process.env.FAXAGE_USERNAME = 'u'
  process.env.FAXAGE_PASSWORD = 'p'
  fx.sd = { account_id: 'acc-1' }
  fx.account = { ...NM_ACCOUNT }
  fx.ss4 = { county_and_state: 'Bernalillo County, New Mexico' }
  fx.agent = { state: 'NM', county: 'Bernalillo' }
  fx.doc = null
  fx.fail = { sd: false, accounts: false, doc: false }
  fx.sendCalls = 0
})

describe('fax send — SS-4 state gate', () => {
  it('THE TANTO PER CASE: the SS-4 panel is REFUSED (409, plain reason) while the registered agent is in Wyoming — nothing is sent', async () => {
    fx.agent = { state: 'WY', county: 'Sheridan' }
    fx.ss4 = { county_and_state: 'Sheridan County, Wyoming' }
    const res = await send({ service_delivery_id: 'sd-1', dedupe_service_delivery_id: 'sd-1', document_id: 'doc-1' })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.error).toContain('in Wyoming')
    expect(body.error).toContain('formed in New Mexico')
    expect(body.error).toContain('Nothing was faxed')
    expect(fx.sendCalls).toBe(0)
  })

  it('a Line 6 printed with the wrong state is refused even when the agent has since been corrected (the signed form still says Wyoming)', async () => {
    fx.ss4 = { county_and_state: 'Sheridan County, Wyoming' }
    const res = await send({ service_delivery_id: 'sd-1', dedupe_service_delivery_id: 'sd-1', document_id: 'doc-1' })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toContain('Line 6 of this SS-4 says Wyoming')
    expect(body.error).toContain('Re-send for Signature')
    expect(fx.sendCalls).toBe(0)
  })

  it('a consistent SS-4 is NOT stopped by the gate (it goes on to the normal checks)', async () => {
    const res = await send({ service_delivery_id: 'sd-1', dedupe_service_delivery_id: 'sd-1' })
    const body = await res.json().catch(() => ({}))
    expect(String(body.error ?? '')).not.toContain('registered agent')
    expect(String(body.error ?? '')).not.toContain('Line 6')
  })

  it('ANY send of a stored SS-4 / IRS-package document is gated, even without the panel flag', async () => {
    fx.agent = { state: 'WY', county: 'Sheridan' }
    for (const type of ['SS-4 + Articles (IRS Package)', 'Form SS-4 (Signed)']) {
      fx.doc = { id: 'doc-1', account_id: 'acc-1', document_type_name: type, file_name: 'x.pdf', drive_file_id: 'store:s1' }
      const res = await send({ document_id: 'doc-1' })
      expect(res.status).toBe(409)
      expect((await res.json()).error).toContain('in Wyoming')
    }
    expect(fx.sendCalls).toBe(0)
  })

  it('a document that is NOT an SS-4 is not gated', async () => {
    fx.agent = { state: 'WY', county: 'Sheridan' }
    fx.doc = { id: 'doc-2', account_id: 'acc-1', document_type_name: 'Tax Return', file_name: 'x.pdf', drive_file_id: 'store:s2' }
    const res = await send({ document_id: 'doc-2' })
    const body = await res.json().catch(() => ({}))
    expect(String(body.error ?? '')).not.toContain('registered agent')
  })

  it('FAILS CLOSED: a check that cannot be completed is a 503 "NOT sent", never a pass', async () => {
    fx.fail.sd = true
    const a = await send({ service_delivery_id: 'sd-1', dedupe_service_delivery_id: 'sd-1', document_id: 'doc-1' })
    expect(a.status).toBe(503)
    expect((await a.json()).error).toContain('NOT sent')
    fx.fail = { sd: false, accounts: true, doc: false }
    const b = await send({ service_delivery_id: 'sd-1', dedupe_service_delivery_id: 'sd-1', document_id: 'doc-1' })
    expect(b.status).toBe(503)
    fx.fail = { sd: false, accounts: false, doc: true }
    const c = await send({ document_id: 'doc-1' })
    expect(c.status).toBe(503)
    expect(fx.sendCalls).toBe(0)
  })
})
