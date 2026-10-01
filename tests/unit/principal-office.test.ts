import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Principal office on an Annual Report filing (Antonio 2026-10-01): staff say whether the principal address changed on
 * the filed report; "changed" replaces the company's saved Principal Office, both leave a dated note on the account.
 */

vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: { from: vi.fn() } }))

import { supabaseAdmin } from '@/lib/supabase-admin'
import { parsePrincipalOfficeDecision, applyPrincipalOfficeDecision, getPrincipalOfficeText } from '@/lib/operations/principal-office'
import { fileRenewal } from '@/lib/operations/file-renewal'

let account: Record<string, unknown>
let oldAddress: Record<string, unknown> | null
let existingMatches: Array<{ id: string }>
let ops: Array<{ table: string; op: 'insert' | 'update'; row: Record<string, unknown> }>

function install() {
  ops = []
  vi.mocked(supabaseAdmin.from).mockImplementation(((table: string) => {
    const chain: Record<string, unknown> = {}
    const self = () => chain
    for (const m of ['select', 'eq', 'ilike', 'limit']) chain[m] = self
    chain.maybeSingle = () => Promise.resolve({ data: table === 'accounts' ? account : oldAddress, error: null })
    chain.single = () => Promise.resolve({ data: { id: 'new-addr' }, error: null })
    chain.insert = (row: Record<string, unknown>) => { ops.push({ table, op: 'insert', row }); return chain }
    chain.update = (row: Record<string, unknown>) => { ops.push({ table, op: 'update', row }); return chain }
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: table === 'addresses' ? existingMatches : [], error: null }).then(resolve)
    return chain
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any)
}

beforeEach(() => {
  vi.clearAllMocks()
  account = { company_name: 'Acme LLC', notes: 'old note', business_legal_address_id: 'addr-old' }
  oldAddress = { address_line1: '30 N Gould St', address_line2: null, city: 'Sheridan', state: 'WY', zip: '82801' }
  existingMatches = []
  install()
})

describe('parsePrincipalOfficeDecision', () => {
  it('refuses anything that is not an explicit answer', () => {
    for (const bad of [null, undefined, {}, { changed: 'maybe' }, 'x']) {
      const r = parsePrincipalOfficeDecision(bad)
      expect(r.ok).toBe(false)
      expect(r.error).toMatch(/principal address changed/i)
    }
  })
  it('"unchanged" is accepted as is', () => {
    expect(parsePrincipalOfficeDecision({ changed: false })).toEqual({ ok: true, decision: { changed: false } })
  })
  it('"changed" needs street, city, state and ZIP and names what is missing', () => {
    const r = parsePrincipalOfficeDecision({ changed: true, address_line1: '1 Main St', city: '  ', state: 'FL' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/city/)
    expect(r.error).toMatch(/ZIP/)
    expect(r.error).not.toMatch(/street/)
  })
  it('a complete change is trimmed; line 2 is optional', () => {
    expect(parsePrincipalOfficeDecision({ changed: true, address_line1: ' 1 Main St ', city: 'Town', state: 'FL', zip: '33771' })).toEqual({
      ok: true,
      decision: { changed: true, address_line1: '1 Main St', address_line2: null, city: 'Town', state: 'FL', zip: '33771' },
    })
  })
})

describe('getPrincipalOfficeText', () => {
  it('returns the saved principal office as one line, or null when none is on file', async () => {
    expect(await getPrincipalOfficeText('a1')).toBe('30 N Gould St, Sheridan WY 82801')
    account = { business_legal_address_id: null }
    expect(await getPrincipalOfficeText('a1')).toBeNull()
  })
})

describe('applyPrincipalOfficeDecision', () => {
  const base = { accountId: 'a1', actor: 'test', filedDate: '2026-10-02', year: 2026 }

  it('unchanged: writes only a dated note — no address is created or relinked', async () => {
    const r = await applyPrincipalOfficeDecision({ ...base, decision: { changed: false } })
    expect(r.changed).toBe(false)
    expect(ops.filter(o => o.table === 'addresses')).toHaveLength(0)
    const upd = ops.filter(o => o.table === 'accounts' && o.op === 'update')
    expect(upd).toHaveLength(1)
    expect(upd[0].row.notes).toContain('old note')
    expect(upd[0].row.notes).toContain('address on the Articles confirmed unchanged')
    expect(upd[0].row.business_legal_address_id).toBeUndefined()
  })

  it('changed: saves the new address as the Principal Office, verifies the link, and notes old → new', async () => {
    const r = await applyPrincipalOfficeDecision({
      ...base,
      decision: { changed: true, address_line1: '16192 Coastal Hwy', address_line2: null, city: 'Lewes', state: 'DE', zip: '19958' },
    })
    expect(r.changed).toBe(true)
    expect(r.address_id).toBe('new-addr')
    const ins = ops.find(o => o.table === 'addresses' && o.op === 'insert')!
    expect(ins.row).toMatchObject({ kind: 'business_legal', address_line1: '16192 Coastal Hwy', city: 'Lewes', is_td_provided: false, active: true })
    const link = ops.find(o => o.table === 'accounts' && o.row.business_legal_address_id)!
    expect(link.row).toMatchObject({ business_legal_address_id: 'new-addr', legal_link_verified: true })
    const note = ops.filter(o => o.table === 'accounts' && o.row.notes).pop()!
    expect(String(note.row.notes)).toContain('address on the Articles CHANGED: 30 N Gould St, Sheridan WY 82801 → 16192 Coastal Hwy, Lewes DE 19958')
  })

  it('changed to an address that is already saved: reuses it, creates no duplicate', async () => {
    existingMatches = [{ id: 'addr-existing' }]
    await applyPrincipalOfficeDecision({
      ...base,
      decision: { changed: true, address_line1: '16192 Coastal Hwy', address_line2: null, city: 'Lewes', state: 'DE', zip: '19958' },
    })
    expect(ops.filter(o => o.table === 'addresses' && o.op === 'insert')).toHaveLength(0)
    expect(ops.find(o => o.table === 'accounts' && o.row.business_legal_address_id)!.row.business_legal_address_id).toBe('addr-existing')
  })
})

describe('fileRenewal — an Annual Report cannot be filed without the principal-address answer', () => {
  it('refuses kind "ar" with no answer, before anything is written', async () => {
    const res = await fileRenewal({
      account_id: 'a1', delivery_id: null, kind: 'ar', filed_date: '2026-10-02',
      receipt: { file_name: 'r.pdf', mime_type: 'application/pdf', data: Buffer.from('x') },
    })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/principal address changed/i)
    expect(ops).toHaveLength(0)
  })
})
