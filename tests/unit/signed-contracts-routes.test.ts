import { describe, it, expect, vi, beforeEach } from 'vitest'

const getUser = vi.fn()
vi.mock('@/lib/supabase/server', () => ({ createClient: () => ({ auth: { getUser: () => getUser() } }) }))

type Call = { table: string; op: string; payload?: unknown; filters: Array<[string, string, unknown]> }
const fake = vi.hoisted(() => {
  const calls: Array<{ table: string; op: string; payload?: unknown; filters: Array<[string, string, unknown]> }> = []
  const scripts: Record<string, unknown> = {}
  const result = (call: { table: string; op: string }) => {
    const s = scripts[`${call.table}.${call.op}`]
    return typeof s === 'function' ? (s as (c: unknown) => unknown)(call) : s ?? { data: null, error: null }
  }
  function from(table: string) {
    const call: { table: string; op: string; payload?: unknown; filters: Array<[string, string, unknown]> } = { table, op: 'select', filters: [] }
    const done = () => { calls.push(call); return Promise.resolve(result(call)) }
    const chain: Record<string, unknown> = {
      select: () => chain,
      update: (p: unknown) => { call.op = 'update'; call.payload = p; return chain },
      insert: (p: unknown) => { call.op = 'insert'; call.payload = p; return done() },
      eq: (c: string, v: unknown) => { call.filters.push(['eq', c, v]); return chain },
      is: (c: string, v: unknown) => { call.filters.push(['is', c, v]); return chain },
      in: (c: string, v: unknown) => { call.filters.push(['in', c, v]); return chain },
      maybeSingle: () => done(),
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => done().then(resolve, reject),
    }
    return chain
  }
  return { calls, scripts, from }
})
vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: { from: (t: string) => fake.from(t) } }))

const signedUrl = vi.fn()
vi.mock('@/lib/storage/signed-download', () => ({ createRecordedSignedUrl: (...a: unknown[]) => signedUrl(...a) }))
const loadEntry = vi.fn()
vi.mock('@/lib/signed-contracts/load', () => ({ loadSignedContractEntry: (...a: unknown[]) => loadEntry(...a) }))

import { GET as openRoute } from '@/app/api/crm/signed-contracts/[id]/open/route'
import { POST as amountsRoute } from '@/app/api/crm/signed-contracts/[id]/amounts/route'
import { correctSignedContractAmounts } from '@/lib/signed-contracts/correct'

const ID = '11111111-2222-3333-4444-555555555555'
const owner = { id: 'u1', email: 'Antonio.Durante@tonydurante.us', app_metadata: { role: 'admin' } }
const staff = { id: 'u2', email: 'someone.else@tonydurante.us', app_metadata: { role: 'admin' } }
const client = { id: 'u3', email: 'c@x.com', app_metadata: { role: 'client' } }
const as = (u: unknown) => getUser.mockResolvedValue({ data: { user: u } })
const req = (body?: unknown) => ({ json: async () => body ?? {} }) as unknown as Request
const entryStub = { id: ID, offerToken: 't' }

const calls = (table: string, op: string): Call[] => fake.calls.filter((c) => c.table === table && c.op === op)

beforeEach(() => {
  getUser.mockReset(); signedUrl.mockReset(); loadEntry.mockReset()
  fake.calls.length = 0
  for (const k of Object.keys(fake.scripts)) delete fake.scripts[k]
  loadEntry.mockResolvedValue(entryStub)
  as(staff)
})

describe('open route (staff only)', () => {
  it('refuses a client and a signed-out visitor', async () => {
    for (const u of [client, null]) {
      as(u)
      expect((await openRoute(req(), { params: { id: ID } })).status).toBe(403)
    }
    expect(signedUrl).not.toHaveBeenCalled()
  })

  it('refuses an id that is not a signing record', async () => {
    expect((await openRoute(req(), { params: { id: '../x' } })).status).toBe(400)
  })

  it('signs the path RECORDED on the contract row, for a minute', async () => {
    fake.scripts['contracts.select'] = { data: { pdf_path: 'tok/Tony_Durante_Contract_tok.pdf' }, error: null }
    signedUrl.mockResolvedValue('https://signed.example/file')
    const res = await openRoute(req(), { params: { id: ID } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ url: 'https://signed.example/file' })
    expect(signedUrl).toHaveBeenCalledWith('signed-contracts', 'tok/Tony_Durante_Contract_tok.pdf', 60)
    expect(calls('contracts', 'select')[0].filters).toContainEqual(['eq', 'id', ID])
  })

  it('says plainly when there is no file, or it cannot be signed', async () => {
    fake.scripts['contracts.select'] = { data: { pdf_path: null }, error: null }
    expect((await openRoute(req(), { params: { id: ID } })).status).toBe(404)
    fake.scripts['contracts.select'] = { data: { pdf_path: 'a/b.pdf' }, error: null }
    signedUrl.mockResolvedValue(null)
    const res = await openRoute(req(), { params: { id: ID } })
    expect(res.status).toBe(404)
    expect((await res.json()).error).toMatch(/could not be opened/)
  })
})

describe('amounts route (owner only)', () => {
  it('refuses everyone but an owner, before reading the body', async () => {
    for (const u of [staff, client, null]) {
      as(u)
      const res = await amountsRoute(req({ january: '1', june: '1', expectedUpdatedAt: null }), { params: { id: ID } })
      expect(res.status).toBe(403)
    }
    expect(fake.calls.length).toBe(0)
  })

  it('refuses a bad id and a body it cannot read', async () => {
    as(owner)
    expect((await amountsRoute(req({}), { params: { id: 'nope' } })).status).toBe(400)
    const broken = { json: async () => { throw new Error('bad json') } } as unknown as Request
    expect((await amountsRoute(broken, { params: { id: ID } })).status).toBe(400)
  })

  it('answers with the corrected line', async () => {
    as(owner)
    fake.scripts['contracts.select'] = { data: { id: ID, offer_token: 't', updated_at: 'U1', annual_fee: '2000', installments: '{"jan":1000,"jun":1000}' }, error: null }
    fake.scripts['offers.select'] = { data: { id: 'o', token: 't', contract_type: 'formation', installment_currency: 'USD', recurring_costs: null, account_id: 'acc' }, error: null }
    fake.scripts['contracts.update'] = { data: [{ id: ID }], error: null }
    const res = await amountsRoute(req({ january: '1.250', june: '1,250', expectedUpdatedAt: 'U1' }), { params: { id: ID } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ entry: entryStub })
  })
})

describe('correcting a saved amount', () => {
  const run = (over: Record<string, unknown> = {}) =>
    correctSignedContractAmounts({ contractId: ID, january: '1.250', june: '1,250', expectedUpdatedAt: 'U1', actor: { email: 'antonio@x.us', name: 'Antonio' }, ...over } as never)
  const formation = () => {
    fake.scripts['contracts.select'] = { data: { id: ID, offer_token: 't', updated_at: 'U1', annual_fee: '200010001000', installments: '{"jan":200010001000,"jun":0}' }, error: null }
    fake.scripts['offers.select'] = { data: { id: 'o', token: 't', contract_type: 'formation', installment_currency: 'USD', recurring_costs: null, account_id: 'acc-1' }, error: null }
    fake.scripts['contracts.update'] = { data: [{ id: ID }], error: null }
    fake.scripts['action_log.insert'] = { error: null }
  }

  it('refuses an amount it cannot read BEFORE touching anything', async () => {
    const r = await run({ january: 'abc' })
    expect(r).toMatchObject({ kind: 'refused', status: 422 })
    expect((r as { error: string }).error).toMatch(/^January:/)
    const r2 = await run({ june: '' })
    expect((r2 as { error: string }).error).toMatch(/^June:/)
    expect(fake.calls.length).toBe(0)
  })

  it('writes the exact shape the signing page writes, only if nobody changed it since', async () => {
    formation()
    const r = await run()
    expect(r.kind).toBe('ok')
    const [update] = calls('contracts', 'update')
    expect(update.payload).toMatchObject({ annual_fee: '2500', installments: '{"jan":1250,"jun":1250}' })
    expect((update.payload as { updated_at: string }).updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(update.filters).toContainEqual(['eq', 'id', ID])
    expect(update.filters).toContainEqual(['eq', 'updated_at', 'U1'])
    // nothing else is written: no invoice, no account, no other table
    expect(fake.calls.filter((c) => c.op === 'update').map((c) => c.table)).toEqual(['contracts'])
  })

  it('a record that never had an updated_at is matched on null', async () => {
    formation()
    await run({ expectedUpdatedAt: null })
    expect(calls('contracts', 'update')[0].filters).toContainEqual(['is', 'updated_at', null])
  })

  it('keeps the old value, the new value and who changed it', async () => {
    formation()
    await run()
    const [log] = calls('action_log', 'insert')
    expect(log.payload).toMatchObject({
      actor: 'crm-admin',
      action_type: 'signed_contract_amounts_corrected',
      table_name: 'contracts',
      record_id: ID,
      account_id: 'acc-1',
    })
    const d = (log.payload as { details: Record<string, unknown> }).details
    expect(d).toMatchObject({ offer_token: 't', by: 'antonio@x.us', by_name: 'Antonio', now_text: 'January $1,250 · June $1,250' })
    expect(d.was_text).toBe('January $200,010,001,000 · June $0')
    expect(d.was).toEqual({ annual_fee: '200010001000', installments: '{"jan":200010001000,"jun":0}' })
  })

  it('refuses when someone else changed the record in the meantime', async () => {
    formation()
    fake.scripts['contracts.update'] = { data: [], error: null }
    const r = await run()
    expect(r).toMatchObject({ kind: 'refused', status: 409 })
    expect((r as { error: string }).error).toMatch(/changed by someone else/)
    expect(calls('action_log', 'insert').length).toBe(0)
  })

  it('refuses a kind of contract that has no installment amounts', async () => {
    fake.scripts['contracts.select'] = { data: { id: ID, offer_token: 't', updated_at: 'U1', annual_fee: null, installments: null }, error: null }
    fake.scripts['offers.select'] = { data: { id: 'o', token: 't', contract_type: 'tax_return', installment_currency: null, recurring_costs: null, account_id: null }, error: null }
    const r = await run()
    expect(r).toMatchObject({ kind: 'refused', status: 409 })
    expect(fake.calls.some((c) => c.op === 'update')).toBe(false)
  })

  it('says so when the signing or its offer is not found', async () => {
    expect(await run()).toMatchObject({ kind: 'refused', status: 404 })
  })

  it('corrects a renewal on the annual agreement and logs it under the signing record', async () => {
    fake.scripts['contracts.select'] = { data: { id: ID, offer_token: 'r', updated_at: 'C1', annual_fee: null, installments: null }, error: null }
    fake.scripts['offers.select'] = { data: { id: 'o', token: 'r', contract_type: 'renewal', installment_currency: null, recurring_costs: null, account_id: null }, error: null }
    const cost = [
      { label: 'First Installment (January)', items: [{ name: 'Annual Management', price: '$1,000' }], total: '$1,000' },
      { label: 'Second Installment (June)', items: [{ name: 'Annual Management', price: '$1,000' }], total: '$1,000' },
    ]
    fake.scripts['annual_agreements.select'] = { data: { id: 'ag-1', token: 'r', account_id: 'acc-9', updated_at: 'A1', cost_summary: cost }, error: null }
    fake.scripts['annual_agreements.update'] = { data: [{ id: 'ag-1' }], error: null }
    fake.scripts['action_log.insert'] = { error: null }
    const r = await run({ expectedUpdatedAt: 'A1' })
    expect(r.kind).toBe('ok')
    const [update] = calls('annual_agreements', 'update')
    const written = (update.payload as { cost_summary: typeof cost }).cost_summary
    expect(written[0].total).toBe('$1,250')
    expect(written[1].items[0].price).toBe('$1,250')
    expect(update.filters).toContainEqual(['eq', 'id', 'ag-1'])
    expect(update.filters).toContainEqual(['eq', 'updated_at', 'A1'])
    expect(fake.calls.some((c) => c.table === 'contracts' && c.op === 'update')).toBe(false)
    const [log] = calls('action_log', 'insert')
    expect(log.payload).toMatchObject({ table_name: 'annual_agreements', record_id: ID, account_id: 'acc-9' })
    expect((log.payload as { details: { was_text: string } }).details.was_text).toBe('January $1,000 · June $1,000')
  })

  it('refuses a renewal whose amounts are laid out in a way it cannot edit', async () => {
    fake.scripts['contracts.select'] = { data: { id: ID, offer_token: 'r', updated_at: 'C1', annual_fee: null, installments: null }, error: null }
    fake.scripts['offers.select'] = { data: { id: 'o', token: 'r', contract_type: 'renewal', installment_currency: null, recurring_costs: null, account_id: null }, error: null }
    fake.scripts['annual_agreements.select'] = { data: { id: 'ag-1', token: 'r', account_id: null, updated_at: 'A1', cost_summary: [{ label: 'x', total: '$1' }] }, error: null }
    const r = await run({ expectedUpdatedAt: 'A1' })
    expect(r).toMatchObject({ kind: 'refused', status: 409 })
    expect(fake.calls.some((c) => c.op === 'update')).toBe(false)
  })

  it('still reports the saved amounts when the history line cannot be written, and gives back the old amount', async () => {
    formation()
    fake.scripts['action_log.insert'] = { error: { message: 'boom' } }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await run()
    expect(r.kind).toBe('ok')
    const warning = (r as { warning?: string }).warning ?? ''
    expect(warning).toMatch(/history line/)
    // the old (wrong) amount is not lost: it is on the screen for the person who changed it ...
    expect(warning).toContain('January $200,010,001,000 · June $0')
    // ... and the whole record, old value and who, goes to the server log
    const logged = spy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(logged).toContain('"was_text":"January $200,010,001,000 · June $0"')
    expect(logged).toContain('"by":"antonio@x.us"')
    spy.mockRestore()
  })

  it('never reports a saved correction as a failed one when the line cannot be read back', async () => {
    formation()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    loadEntry.mockRejectedValue(new Error('read timed out'))
    const thrown = await run()
    expect(thrown.kind).toBe('ok')
    expect((thrown as { entry: unknown }).entry).toBeNull()
    expect((thrown as { warning?: string }).warning).toMatch(/saved, but this line could not be refreshed/)

    loadEntry.mockResolvedValue(null)
    const empty = await run()
    expect(empty.kind).toBe('ok')
    expect((empty as { entry: unknown }).entry).toBeNull()
    expect((empty as { warning?: string }).warning).toMatch(/could not be refreshed/)
    spy.mockRestore()
  })

  it('says the real cause when the offer or the agreement cannot be read', async () => {
    fake.scripts['contracts.select'] = { data: { id: ID, offer_token: 't', updated_at: 'U1', annual_fee: null, installments: null }, error: null }
    fake.scripts['offers.select'] = { data: null, error: { message: 'timeout' } }
    const r1 = await run()
    expect(r1).toMatchObject({ kind: 'refused', status: 500 })
    expect((r1 as { error: string }).error).toMatch(/timeout/)

    fake.scripts['offers.select'] = { data: { id: 'o', token: 'r', contract_type: 'renewal', installment_currency: null, recurring_costs: null, account_id: null }, error: null }
    fake.scripts['annual_agreements.select'] = { data: null, error: { message: 'timeout' } }
    const r2 = await run()
    expect(r2).toMatchObject({ kind: 'refused', status: 500 })
    expect(fake.calls.some((c) => c.op === 'update')).toBe(false)
  })
})

describe('amounts route — answers when the line could not be read back', () => {
  it('answers 200 with entry null and the warning, not an error', async () => {
    as(owner)
    fake.scripts['contracts.select'] = { data: { id: ID, offer_token: 't', updated_at: 'U1', annual_fee: '2000', installments: '{"jan":1000,"jun":1000}' }, error: null }
    fake.scripts['offers.select'] = { data: { id: 'o', token: 't', contract_type: 'formation', installment_currency: 'USD', recurring_costs: null, account_id: 'acc' }, error: null }
    fake.scripts['contracts.update'] = { data: [{ id: ID }], error: null }
    loadEntry.mockResolvedValue(null)
    const res = await amountsRoute(req({ january: '1250', june: '1250', expectedUpdatedAt: 'U1' }), { params: { id: ID } })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.entry).toBeNull()
    expect(body.warning).toMatch(/could not be refreshed/)
  })

  it('refuses a body that is not an object (null, a list, a number)', async () => {
    as(owner)
    for (const body of [null, [1, 2], 5]) {
      const r = { json: async () => body } as unknown as Request
      expect((await amountsRoute(r, { params: { id: ID } })).status).toBe(400)
    }
    expect(fake.calls.length).toBe(0)
  })
})
