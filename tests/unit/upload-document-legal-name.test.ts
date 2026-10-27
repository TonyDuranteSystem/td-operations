/**
 * Job 80cce1cb — the upload route checks the staff-confirmed company legal name on the SERVER, before anything is stored: a valid
 * ending, the filed name's words (unless staff ticked that the Articles differ), and it saves the exact confirmed name on the filed
 * name BEFORE the file is stored. A refused name leaves the staged file untouched so staff just fix the field and press Confirm again.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const h = vi.hoisted(() => ({
  sd: { id: 'sd-1', account_id: null as string | null, contact_id: 'c-1' as string | null, stage: 'Filed with State', service_type: 'Company Formation', due_date: null },
  nameChecks: [{ name: 'Tanto per', source: 'wizard', status: 'filed', updated_at: null }] as unknown[],
  saved: [] as string[],
  saveResult: { ok: true, saved: true } as { ok: boolean; error?: string; saved?: boolean },
  downloads: 0,
  advanced: [] as unknown[],
}))

vi.mock('@/lib/auth/require-staff-route', () => ({ requireStaffRoute: async () => null }))
vi.mock('@/lib/service-delivery', () => ({ advanceServiceDelivery: vi.fn(async (p: unknown) => { h.advanced.push(p); return { success: true } }) }))
vi.mock('@/lib/operations/formation-name-checks', () => ({
  saveConfirmedLegalName: vi.fn(async (p: { legalName: string }) => { h.saved.push(p.legalName); return h.saveResult }),
}))
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        order: () => chain,
        limit: () => chain,
        single: () => Promise.resolve({ data: h.sd, error: null }),
        maybeSingle: () => Promise.resolve({ data: table === 'service_deliveries' ? { name_checks: h.nameChecks } : null, error: null }),
      }
      return chain
    },
    storage: {
      from: () => ({
        download: async () => { h.downloads++; return { data: null, error: { message: 'stop here' } } },
        remove: async () => ({ data: null, error: null }),
      }),
    },
  },
}))

import { POST } from '@/app/api/flows/[id]/upload-document/route'

const call = async (body: Record<string, unknown>) => {
  const res = await POST(
    new NextRequest('http://localhost/api/flows/sd-1/upload-document', { method: 'POST', body: JSON.stringify({ storage_path: 'flow-uploads/sd-1/a.pdf', file_name: 'Articles.pdf', flow_stage: 'Filed with State', ...body }) }),
    { params: { id: 'sd-1' } },
  )
  return { status: res.status, body: await res.json() }
}

beforeEach(() => {
  h.sd = { id: 'sd-1', account_id: null, contact_id: 'c-1', stage: 'Filed with State', service_type: 'Company Formation', due_date: null }
  h.nameChecks = [{ name: 'Tanto per', source: 'wizard', status: 'filed', updated_at: null }]
  h.saved = []
  h.saveResult = { ok: true, saved: true }
  h.downloads = 0
  h.advanced = []
})

describe('upload-document — confirmed company legal name (server side)', () => {
  it('no legal name sent (an old caller): nothing is validated or saved — the name is derived by the rule', async () => {
    const r = await call({})
    expect(r.status).toBe(500) // stopped at the mocked storage download, i.e. it got past the name step
    expect(h.saved).toEqual([])
    expect(h.downloads).toBe(1)
  })

  it('the Articles spelling ("Tanto Per LLC") is accepted and saved EXACTLY as typed, before the file is stored', async () => {
    const r = await call({ legal_name: 'Tanto Per LLC' })
    expect(h.saved).toEqual(['Tanto Per LLC'])
    expect(h.downloads).toBe(1) // saved first, then it went on to the (mocked, failing) download
    expect(r.status).toBe(500)
  })

  it('a name WITHOUT an ending is refused with a plain sentence — nothing saved, the staged file is not touched', async () => {
    const r = await call({ legal_name: 'Tanto per' })
    expect(r.status).toBe(400)
    expect(r.body.detail).toContain('must end in LLC')
    expect(r.body.error).toBe(r.body.detail) // the window reads either (R099: show the server's reason)
    expect(h.saved).toEqual([])
    expect(h.downloads).toBe(0)
  })

  it('"Acme Inc" is refused and names the ending', async () => {
    h.nameChecks = [{ name: 'Acme Inc', source: 'wizard', status: 'filed', updated_at: null }]
    const r = await call({ legal_name: 'Acme Inc' })
    expect(r.status).toBe(400)
    expect(r.body.detail).toContain('"Inc"')
    expect(h.saved).toEqual([])
  })

  it('different WORDS from the filed name are refused unless staff ticked that the Articles differ', async () => {
    const refused = await call({ legal_name: 'Tanto per Italia LLC' })
    expect(refused.status).toBe(400)
    expect(refused.body.detail).toContain('differs from the filed name')
    expect(h.saved).toEqual([])
    const ok = await call({ legal_name: 'Tanto per Italia LLC', legal_name_differs: true })
    expect(h.saved).toEqual(['Tanto per Italia LLC'])
    expect(ok.status).toBe(500) // past the name step
  })

  it('a zero-width character cannot slip a name past the ending check, and is stripped from what is saved', async () => {
    await call({ legal_name: 'Tanto Per​ LLC​' })
    expect(h.saved).toEqual(['Tanto Per LLC'])
  })

  it('a save that fails (someone changed the case meanwhile) is a plain 409 and the file is not stored', async () => {
    h.saveResult = { ok: false, error: 'The names changed while you were working. Reload the page and try again.' }
    const r = await call({ legal_name: 'Tanto Per LLC' })
    expect(r.status).toBe(409)
    expect(r.body.detail).toContain('changed while you were working')
    expect(h.downloads).toBe(0)
  })

  it('only a Company Formation with no company yet takes a legal name — anything else ignores the field', async () => {
    h.sd = { ...h.sd, service_type: 'ITIN' }
    await call({ legal_name: 'whatever' })
    expect(h.saved).toEqual([])
    h.sd = { ...h.sd, service_type: 'Company Formation', account_id: 'acct-1' }
    await call({ legal_name: 'whatever' })
    expect(h.saved).toEqual([])
  })

  it('nothing filed and no wizard name: only the ending is checked', async () => {
    h.nameChecks = []
    await call({ legal_name: 'Brand New LLC' })
    expect(h.saved).toEqual(['Brand New LLC'])
  })
})
