/**
 * The SS-4 Responsible Party signs the SS-4 IN THE PORTAL, so a person whose link to the company carries the "no portal access"
 * mark can never be chosen as the signer (dev job beb43385, QA 21 Nov 2026 — the SS-4 was created for a form-marked member and the
 * "Sign your SS-4" alert reached someone who could not open the company).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  link: null as { contact_id: string; access_revoked_at: string | null } | null,
  tables: [] as string[],
}))

vi.mock('@/lib/supabase-admin', () => {
  const builderFor = (table: string) => {
    const b: Record<string, unknown> = {}
    b.select = () => b
    b.eq = () => b
    b.maybeSingle = () => {
      if (table === 'ss4_applications') return Promise.resolve({ data: { id: 's1', token: 't', access_code: 'c', status: 'draft', signed_at: null, contact_id: 'old', company_name: 'Co' }, error: null })
      if (table === 'account_contacts') return Promise.resolve({ data: h.link, error: null })
      return Promise.resolve({ data: null, error: null }) // contacts: none, so an unmarked pick stops at "no_contact"
    }
    return b
  }
  return { supabaseAdmin: { from: (table: string) => { h.tables.push(table); return builderFor(table) } } }
})

import { setSs4Signer } from '@/lib/operations/ss4-set-signer'

beforeEach(() => { h.link = null; h.tables = [] })

describe('setSs4Signer and the no-portal-access mark', () => {
  it('refuses a person whose link carries the mark, before reading anything about them or writing anything', async () => {
    h.link = { contact_id: 'c1', access_revoked_at: '2026-11-21T00:00:00Z' }
    const r = await setSs4Signer({ account_id: 'acc', contact_id: 'c1', source: 'test' })
    expect(r.ok).toBe(false)
    expect(r.outcome).toBe('signer_no_portal_access')
    expect(r.message).toMatch(/no portal access/i)
    expect(h.tables).not.toContain('contacts')
  })

  it('a person who can open the company goes on to the normal checks', async () => {
    h.link = { contact_id: 'c1', access_revoked_at: null }
    const r = await setSs4Signer({ account_id: 'acc', contact_id: 'c1', source: 'test' })
    expect(r.outcome).toBe('no_contact') // the mocked contacts read returns nothing: proof the mark check did not stop it
  })
})

describe('createSS4 wiring', () => {
  const src = readFileSync(join(__dirname, '..', '..', 'lib', 'operations', 'ss4.ts'), 'utf8')

  it('asks whether the chosen signer is marked, and refuses with its own outcome', () => {
    expect(src).toContain('isMarkedOnCompany(params.account_id, contactId)')
    expect(src).toContain('outcome: "signer_no_portal_access"')
  })

  it('asks BEFORE the SS-4 row is inserted', () => {
    const asked = src.indexOf('isMarkedOnCompany(params.account_id, contactId)')
    const inserted = src.indexOf('.insert(prep.prepared.row')
    expect(asked).toBeGreaterThan(-1)
    expect(inserted).toBeGreaterThan(asked)
  })
})
