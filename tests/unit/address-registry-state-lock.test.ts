/**
 * Dev job ff2b73d7 — a registered-agent registry entry that companies are using cannot be moved to another state. Editing the Sheridan
 * entry from "WY" to "NM" would make a wrong-state agent look right (Line 6 would read "Sheridan County, New Mexico") and break every
 * Wyoming company on it. Any other edit is untouched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const fx = vi.hoisted(() => ({
  before: { kind: 'registered_agent', state: 'WY' } as Record<string, unknown> | null,
  linked: 3,
  updates: [] as Array<Record<string, unknown>>,
  beforeReads: 0,
}))

vi.mock('@/lib/auth/require-staff-route', () => ({ requireStaffRoute: async () => null }))
vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: { from: () => ({ insert: async () => ({ error: null }) }) } }))
vi.mock('@/lib/addresses', () => ({
  linkedAccountCount: async () => fx.linked,
  freshAddressClient: () => ({
    from: () => {
      let op = 'select'
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b: any = {}
      b.select = () => b
      b.eq = () => b
      b.update = (u: Record<string, unknown>) => { op = 'update'; fx.updates.push(u); return b }
      b.maybeSingle = () => { if (op === 'select') fx.beforeReads++; return Promise.resolve({ data: fx.before, error: null }) }
      b.single = () => Promise.resolve({ data: { id: 'ra-1', name: 'Registered Agents Inc', kind: 'registered_agent', ...fx.updates[fx.updates.length - 1] }, error: null })
      return b
    },
  }),
}))

import { PATCH } from '@/app/api/addresses/[id]/route'

const patch = (body: Record<string, unknown>) =>
  PATCH(new NextRequest('http://localhost/api/addresses/ra-1', { method: 'PATCH', body: JSON.stringify(body) }), { params: { id: 'ra-1' } })

beforeEach(() => {
  fx.before = { kind: 'registered_agent', state: 'WY' }
  fx.linked = 3
  fx.updates = []
  fx.beforeReads = 0
})

describe('registry entry — state lock', () => {
  it('REFUSES to move a registered agent that companies use to another state, and says why and what to do', async () => {
    const res = await patch({ state: 'NM' })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toContain('used by 3 companies')
    expect(body.error).toContain('Add a new entry for the other state')
    expect(fx.updates).toHaveLength(0)
  })

  it('a single company is named in the singular', async () => {
    fx.linked = 1
    expect((await (await patch({ state: 'New Mexico' })).json()).error).toContain('used by 1 company,')
  })

  it('an entry nobody uses can still be corrected', async () => {
    fx.linked = 0
    expect((await patch({ state: 'NM' })).status).toBe(200)
    expect(fx.updates[0].state).toBe('NM')
  })

  it('"WY" -> "Wyoming" is the same state: a spelling fix is allowed', async () => {
    expect((await patch({ state: 'Wyoming' })).status).toBe(200)
  })

  it('any other edit (county, name, ZIP) is untouched and does not even read the old row', async () => {
    expect((await patch({ county: 'Sheridan', zip: '82801' })).status).toBe(200)
    expect(fx.beforeReads).toBe(0)
  })

  it('an entry that is not a registered agent (a mailing address) keeps the old behaviour', async () => {
    fx.before = { kind: 'business_mailing', state: 'FL' }
    expect((await patch({ state: 'NM' })).status).toBe(200)
  })
})
