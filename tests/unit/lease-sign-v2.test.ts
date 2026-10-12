import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { newYorkToday, addMonthsIso } from '@/lib/lease/agreement-v2'

/**
 * Signing the Office Lease and Services Agreement (template v2): the client's Operating Address is required, the printed
 * signing date must still be today in New York (a tab left open past midnight is refused), and the server — not the
 * browser — writes the Effective Date and the 12-month term. A v1 lease signs exactly as before.
 */

let leaseRow: Record<string, unknown>
let updates: Record<string, unknown>[]

vi.mock('@/lib/esign/access-guard', () => ({ accessCodeError: () => null }))
vi.mock('@/lib/supabase-admin', () => {
  const from = () => {
    let isUpdate = false
    const chain: Record<string, unknown> = {}
    const self = () => chain
    for (const m of ['select', 'eq', 'neq']) chain[m] = self
    chain.update = (u: Record<string, unknown>) => {
      isUpdate = true
      updates.push(u)
      return chain
    }
    chain.maybeSingle = () => Promise.resolve(isUpdate ? { data: { id: 'l1' }, error: null } : { data: leaseRow, error: null })
    return chain
  }
  return { supabaseAdmin: { from, storage: { from: () => ({ list: async () => ({ data: [{ name: 'lease.pdf' }], error: null }) }) } } }
})

const PAGE = { suite_number: '3D-318', tenant_company: 'Acme LLC' }
async function sign(body: Record<string, unknown>, withPage = true) {
  const { POST } = await import('@/app/api/lease/[token]/sign/route')
  const req = new NextRequest('http://localhost/api/lease/acme-2026/sign', {
    method: 'POST',
    body: JSON.stringify({ code: 'x', pdf_storage_path: 'acme-2026/lease.pdf', ...(withPage ? PAGE : {}), ...body }),
  })
  return POST(req, { params: Promise.resolve({ token: 'acme-2026' }) })
}

describe('lease sign route — template v2', () => {
  beforeEach(() => {
    vi.resetModules()
    updates = []
    leaseRow = { id: 'l1', access_code: null, status: 'viewed', template_version: 2, suite_number: '3D-318', tenant_company: 'Acme LLC' }
  })

  it('refuses a signature with no Operating Address', async () => {
    const res = await sign({ signing_date: newYorkToday() })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/Operating Address/)
    expect(updates).toHaveLength(0)
  })

  it('refuses a signature whose printed date is no longer today in New York, with a reload code', async () => {
    const res = await sign({ operating_address: 'Via Roma 1, Milano, Italy', signing_date: '2020-01-01' })
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('date_changed')
    expect(updates).toHaveLength(0)
  })

  it('refuses a v2 signature that carries no printed date at all', async () => {
    const res = await sign({ operating_address: 'Via Roma 1, Milano, Italy' })
    expect(res.status).toBe(409)
  })

  it('refuses a signature when staff changed the company number or name while the page was open (the PDF would contradict the record)', async () => {
    const today = newYorkToday()
    let res = await sign({ operating_address: 'Via Roma 1, Milano', signing_date: today, suite_number: '3D-205' })
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('lease_changed')
    res = await sign({ operating_address: 'Via Roma 1, Milano', signing_date: today, tenant_company: 'Old Name LLC' })
    expect(res.status).toBe(409)
    expect(updates).toHaveLength(0)
  })

  it('strips line breaks and control characters from the Operating Address', async () => {
    const today = newYorkToday()
    const res = await sign({ operating_address: 'Via Roma 1\n\tMilano\u0000, Italy', signing_date: today })
    expect(res.status).toBe(200)
    expect(updates[0].operating_address).toBe('Via Roma 1  Milano , Italy')
  })

  it('records the Effective Date, a 12-month term and the Operating Address, set by the server', async () => {
    const today = newYorkToday()
    const res = await sign({ operating_address: '  Via Roma 1, Milano, Italy ', signing_date: today })
    expect(res.status).toBe(200)
    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({
      status: 'signed',
      operating_address: 'Via Roma 1, Milano, Italy',
      effective_date: today,
      term_start_date: today,
      term_end_date: addMonthsIso(today, 12),
      term_months: 12,
    })
  })
})

describe('lease sign route — a v1 lease is unchanged', () => {
  beforeEach(() => {
    vi.resetModules()
    updates = []
    leaseRow = { id: 'l1', access_code: null, status: 'viewed' } // no template_version -> v1
  })
  it('signs with no Operating Address and writes none of the v2 fields', async () => {
    const res = await sign({})
    expect(res.status).toBe(200)
    expect(updates[0]).not.toHaveProperty('operating_address')
    expect(updates[0]).not.toHaveProperty('effective_date')
    expect(updates[0]).toMatchObject({ status: 'signed' })
  })
})
