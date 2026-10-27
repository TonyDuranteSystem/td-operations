/**
 * Dev job ff2b73d7 — the REAL /api/tools/fax/send route with the SS-4 check. The claim step is replaced by a stub that answers 418, so
 * "418 STOP-AFTER-CHECK" means "the check let it through and the route went on to send"; anything else is the check's own answer.
 * Antonio's rule: ONLY a fax for a client's company is checked — a fax to a third party is never touched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const fx = vi.hoisted(() => ({
  sd: null as Record<string, unknown> | null,
  account: null as Record<string, unknown> | null,
  ss4: null as Record<string, unknown> | null,
  agent: null as Record<string, unknown> | null,
  doc: null as Record<string, unknown> | null,
  storeFile: null as Record<string, unknown> | null,
  storeOwner: null as Record<string, unknown> | null,
  fail: { sd: false, accounts: false },
  sendCalls: 0,
  claimCalls: 0,
  queried: [] as string[],
}))

vi.mock('@/lib/supabase/server', () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1', email: 'luca@tonydurante.us', app_metadata: { role: 'team' } } } }) } }) }))
vi.mock('@/lib/auth', () => ({ isDashboardUser: () => true, isOwnerOnly: () => false }))
vi.mock('@/lib/google-drive', () => ({ downloadFileBinary: async () => { throw new Error('Drive must not be used') } }))
vi.mock('@/lib/fax/faxage', () => ({
  isProvablyNotSent: () => false,
  sendFax: async () => { fx.sendCalls++; return { ok: true, outcome: 'accepted', jobId: 'J1', raw: 'ok' } },
  isValidFaxNo: (x: string) => String(x).replace(/\D/g, '').length >= 10,
  normalizeFaxNo: (x: string) => x,
  DEFAULT_IRS_FAX_NUMBER: '8552151627',
  IRS_EIN_FAX_DOMESTIC: '8556416935',
  stripBase64Prefix: (b: string) => b,
}))
vi.mock('@/lib/system-errors', () => ({ reportSystemError: async () => {} }))
vi.mock('@/lib/crm-store/document-pointer', () => ({
  parseStorePointer: (p: string) => (p.startsWith('store:') ? p.slice(6) : null),
  staffOnlyStorePointers: async () => new Set(),
  readStoreFile: async () => ({ bytes: Buffer.from('%PDF-1.4 stored'), name: 'stored.pdf' }),
}))
vi.mock('@/lib/fax/send-claim', () => ({
  claimSend: async () => { fx.claimCalls++; return { ok: false, error: 'STOP-AFTER-CHECK', status: 418, code: 'stop' } },
  finishClaim: async () => ({}),
  abandonClaim: async () => {},
  realClaimDeps: async () => ({}),
  HISTORY_NOT_SAVED_SENTENCE: '',
}))
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      fx.queried.push(table)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b: any = {}
      const chain = () => b
      b.select = chain; b.eq = chain; b.in = chain; b.order = chain; b.limit = chain; b.is = chain; b.gte = chain
      const one = () => {
        if (table === 'service_deliveries') return fx.fail.sd ? { data: null, error: { message: 'boom' } } : { data: fx.sd, error: null }
        if (table === 'accounts') return fx.fail.accounts ? { data: null, error: { message: 'boom' } } : { data: fx.account, error: null }
        if (table === 'ss4_applications') return { data: fx.ss4, error: null }
        if (table === 'addresses') return { data: fx.agent, error: null }
        if (table === 'store_files') return { data: fx.storeFile, error: null }
        if (table === 'store_owners') return { data: fx.storeOwner, error: null }
        if (table === 'documents') return { data: fx.doc, error: null }
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

const IRS = '8556416935'
const BANK = '5551234567'
const STORE_FILE = '11111111-1111-4111-8111-111111111111'
const NM_ACCOUNT = { company_name: 'Tanto per LLC', state_of_formation: 'New Mexico', registered_agent_id: 'ra-1' }
const B64 = Buffer.from('%PDF-1.4 hello').toString('base64')

const send = (body: Record<string, unknown>) =>
  POST(new NextRequest('http://localhost/api/tools/fax/send', { method: 'POST', body: JSON.stringify({ faxno: IRS, recip_name: 'IRS', file_base64: B64, file_name: 'Form SS-4 - Tanto per LLC - For IRS.pdf', ...body }) }))

beforeEach(() => {
  process.env.FAXAGE_USERNAME = 'u'
  process.env.FAXAGE_PASSWORD = 'p'
  fx.sd = { account_id: 'acc-1' }
  fx.account = { ...NM_ACCOUNT }
  fx.ss4 = { county_and_state: 'Bernalillo County, New Mexico' }
  fx.agent = { state: 'NM', county: 'Bernalillo' }
  fx.doc = null
  fx.storeFile = { owner_id: 'o1' }
  fx.storeOwner = { kind: 'company', account_id: 'acc-1' }
  fx.fail = { sd: false, accounts: false }
  fx.sendCalls = 0
  fx.claimCalls = 0
  fx.queried = []
})

const WRONG = () => { fx.agent = { state: 'WY', county: 'Sheridan' }; fx.ss4 = { county_and_state: 'Sheridan County, Wyoming' } }

describe('fax send — the SS-4 check (only a fax for a client\'s company)', () => {
  it('THE TANTO PER CASE: the SS-4 panel is REFUSED (409, plain reason) while the registered agent is in Wyoming — nothing claimed, nothing sent', async () => {
    WRONG()
    const res = await send({ service_delivery_id: 'sd-1', dedupe_service_delivery_id: 'sd-1' })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.error).toContain('in Wyoming')
    expect(body.error).toContain('formed in New Mexico')
    expect(body.error).toContain('Nothing was faxed')
    expect(fx.claimCalls).toBe(0)
    expect(fx.sendCalls).toBe(0)
  })

  it('a Line 6 saved with the wrong state is refused even when the agent has since been corrected', async () => {
    fx.ss4 = { county_and_state: 'Sheridan County, Wyoming' }
    const res = await send({ service_delivery_id: 'sd-1', dedupe_service_delivery_id: 'sd-1' })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toContain('Line 6 of this SS-4 says Wyoming')
    expect(body.error).toContain('Re-send for Signature')
    expect(fx.claimCalls).toBe(0)
  })

  it('A FAX TO A THIRD PARTY IS NEVER CHECKED: a company\'s SS-4 (wrong state and all) faxed to a bank goes straight on to sending', async () => {
    WRONG()
    const res = await send({ faxno: BANK, already_stored: true, store_file_id: STORE_FILE })
    expect(res.status).toBe(418) // reached the claim: the check did not touch it
    expect(fx.queried).not.toContain('accounts')
    expect(fx.queried).not.toContain('store_files')
    expect(fx.claimCalls).toBe(1)
  })

  it('a stored SS-4 document of a company in the wrong state is NOT checked when the recipient is a third party', async () => {
    WRONG()
    fx.doc = { id: 'doc-1', account_id: 'acc-1', document_type_name: 'Form SS-4 (Signed)', file_name: 'Form SS-4 - Tanto per LLC - Signed.pdf', drive_file_id: 'store:s1' }
    const res = await send({ faxno: BANK, document_id: 'doc-1', file_base64: undefined })
    expect(res.status).toBe(418)
    expect(fx.queried).not.toContain('accounts')
  })

  it('…but the same stored SS-4 document sent to the IRS EIN line is checked, through the document\'s own company', async () => {
    WRONG()
    fx.doc = { id: 'doc-1', account_id: 'acc-1', document_type_name: 'Form SS-4 (Signed)', file_name: 'Form SS-4 - Tanto per LLC - Signed.pdf', drive_file_id: 'store:s1' }
    const res = await send({ document_id: 'doc-1', file_base64: undefined })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toContain('in Wyoming')
    expect(fx.claimCalls).toBe(0)
  })

  it('a stored document typed with the label the classifier uses ("Form SS-4") is checked too (634 production documents carry it)', async () => {
    WRONG()
    fx.doc = { id: 'doc-2', account_id: 'acc-1', document_type_name: 'Form SS-4', file_name: 'scan 1.pdf', drive_file_id: 'store:s2' }
    const res = await send({ document_id: 'doc-2', file_base64: undefined, file_name: undefined })
    expect(res.status).toBe(409)
  })

  it('an SS-4-typed stored document with NO company cannot slip past: it is refused with "choose the company"', async () => {
    fx.doc = { id: 'doc-3', account_id: null, document_type_name: 'Form SS-4', file_name: 'old.pdf', drive_file_id: 'store:s3' }
    const res = await send({ document_id: 'doc-3', file_base64: undefined })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toContain('Choose the company')
  })

  it('an SS-4 to the IRS with NO company (an upload, "don\'t save") is refused with the "choose the company" sentence', async () => {
    const res = await send({ save_choice: { mode: 'dont_save' } })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toContain('Choose the company')
    expect(fx.claimCalls).toBe(0)
  })

  it('a document that is not an SS-4, sent to the IRS, is not checked', async () => {
    WRONG()
    const res = await send({ file_name: 'Letter to the IRS.pdf', save_choice: { mode: 'dont_save' } })
    expect(res.status).toBe(418)
    expect(fx.queried).not.toContain('accounts')
  })

  it('SHARE → FAX of an SS-4 from the company\'s storage to the IRS is checked through the file\'s company (it used to slip past)', async () => {
    WRONG()
    const res = await send({ already_stored: true, store_file_id: STORE_FILE })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toContain('in Wyoming')
    expect(fx.claimCalls).toBe(0)
  })

  it('…and goes ahead when the company\'s records are right', async () => {
    const res = await send({ already_stored: true, store_file_id: STORE_FILE })
    expect(res.status).toBe(418)
    expect(fx.claimCalls).toBe(1)
  })

  it('FAILS CLOSED: a check that cannot be completed is a 503 "NOT sent", never a pass', async () => {
    fx.fail.sd = true
    const a = await send({ service_delivery_id: 'sd-1', dedupe_service_delivery_id: 'sd-1' })
    expect(a.status).toBe(503)
    expect((await a.json()).error).toContain('NOT sent')
    fx.fail = { sd: false, accounts: true }
    const b = await send({ already_stored: true, store_file_id: STORE_FILE })
    expect(b.status).toBe(503)
    expect(fx.claimCalls).toBe(0)
    expect(fx.sendCalls).toBe(0)
  })
})
