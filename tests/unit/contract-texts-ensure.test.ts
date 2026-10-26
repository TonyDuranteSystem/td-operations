/**
 * ensureOfferContractTexts — WHEN the approved wording is frozen onto an offer, and what is never touched.
 * (Bug-hunter findings, 2026-10-26: the copy was taken at a staff preview and survived a newer approval; the new column
 * was read for every ordinary offer, so shipping before the database change would have broken every Send.)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type R = { data: unknown; error: { message: string } | null }
const db = vi.hoisted(() => ({
  offer: { data: null, error: null } as R,
  copy: { data: null, error: null } as R,
  catalog: { data: [], error: null } as R,
  selects: [] as string[],
  updates: [] as Array<Record<string, unknown>>,
  updateError: null as null | { message: string },
}))
const approved = vi.hoisted(() => ({ value: {} as Record<string, unknown>, calls: [] as string[][] }))

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => ({
      select: (cols: string) => {
        db.selects.push(`${table}:${cols}`)
        const result = table === 'catalog_entries' ? db.catalog : cols === 'contract_texts' ? db.copy : db.offer
        const chain: Record<string, unknown> = { eq: () => (table === 'catalog_entries' ? Promise.resolve(result) : chain), maybeSingle: async () => result }
        return chain
      },
      update: (patch: Record<string, unknown>) => {
        db.updates.push(patch)
        return { eq: async () => ({ error: db.updateError }) }
      },
    }),
  },
}))
vi.mock('@/lib/contracts/service-contract-texts', () => ({
  getApprovedByType: async (types: string[]) => { approved.calls.push(types); return approved.value },
}))

import { ensureOfferContractTexts } from '@/lib/offers/contract-texts-snapshot'

const wording = (t: string) => ({
  title: t, shortTitle: t, pdfPrefix: 'X_Agreement',
  scope: { intro: 'i', items: ['a'], closing: 'c' }, procedure: { intro: 'p', steps: [{ title: 's', desc: 'd' }] },
  commitments: ['c1'], clientDuties: { intro: 'd', items: [{ bold: 'b', rest: ' r' }] }, signatureText: 'sig', successNote: 'ok', workPhrase: 'the work', liabilityPhrase: 'delays',
})
const apRow = (version: number, t: string) => ({ version, content_hash: `hash${version}`, content: wording(t) })
const customOffer = { contract_type: 'custom_apostille', services: [{ name: 'Apostille', pipeline_type: 'Apostille', contract_type: 'custom_apostille' }], packages: null }
const columnReads = () => db.selects.filter((s) => s.includes('contract_texts'))

beforeEach(() => {
  db.offer = { data: customOffer, error: null }
  db.copy = { data: { contract_texts: null }, error: null }
  db.catalog = { data: [], error: null }
  db.selects.length = 0; db.updates.length = 0; db.updateError = null
  approved.value = { custom_apostille: apRow(2, 'v2') }; approved.calls.length = 0
})

describe('an ordinary offer never touches the new column or the contract store', () => {
  it('no new service: only the long-standing columns are read, nothing is written', async () => {
    db.offer = { data: { contract_type: 'tax_return', services: [{ name: 'Tax', pipeline_type: 'Tax Return', contract_type: 'tax_return' }, { name: 'fee' }], packages: null }, error: null }
    for (const opts of [{}, { refresh: true }, { persist: false }]) {
      db.selects.length = 0; db.updates.length = 0
      const r = await ensureOfferContractTexts('t', opts)
      expect(r).toEqual({ texts: {}, missing: [], changed: false })
      expect(columnReads(), JSON.stringify(opts)).toEqual([])
      expect(db.updates).toEqual([])
    }
    expect(approved.calls).toEqual([])
  })
  it('a missing offer answers empty', async () => {
    db.offer = { data: null, error: null }
    expect(await ensureOfferContractTexts('t')).toEqual({ texts: {}, missing: [], changed: false })
  })
})

describe('refresh — the offer is being SENT: take a fresh copy, replace an older one', () => {
  it('an older copy left by a preview or a failed attempt is replaced by today’s approved version', async () => {
    const r = await ensureOfferContractTexts('t', { refresh: true })
    expect(r.texts.custom_apostille).toMatchObject({ version: 2, hash: 'hash2' })
    expect(r.changed).toBe(true)
    expect(db.updates).toEqual([{ contract_texts: r.texts }])
    expect(columnReads().filter((s) => s === 'offers:contract_texts')).toEqual([]) // the old copy is not even read
  })
  it('no approved wording: nothing is written and the type is reported missing (the send is refused)', async () => {
    approved.value = {}
    const r = await ensureOfferContractTexts('t', { refresh: true })
    expect(r.missing).toEqual(['custom_apostille'])
    expect(db.updates).toEqual([])
  })
})

describe('persist: false — a staff preview of a DRAFT', () => {
  it('shows today’s approved wording and writes NOTHING, not even the corrected lines', async () => {
    db.offer = { data: { contract_type: 'custom_apostille', services: [{ name: 'Apostille', pipeline_type: 'Apostille' }], packages: null }, error: null }
    db.catalog = { data: [{ slug: 'apostille', status: 'active', metadata: { pipeline: 'Apostille', contract_type: 'custom_apostille' } }], error: null }
    const r = await ensureOfferContractTexts('t', { persist: false })
    expect(r.texts.custom_apostille.version).toBe(2)
    expect(r.lines).toBeTruthy()
    expect((r.lines!.services as Array<Record<string, unknown>>)[0].contract_type).toBe('custom_apostille')
    expect(db.updates).toEqual([])
    expect(columnReads()).toEqual([])
  })
})

describe('default — completing the copy of an offer that is already out', () => {
  it('keeps what is frozen (never replaced) and adds only what is missing', async () => {
    db.copy = { data: { contract_texts: { custom_apostille: { version: 1, hash: 'h1', content: wording('v1') } } }, error: null }
    const r = await ensureOfferContractTexts('t')
    expect(r.texts.custom_apostille.version).toBe(1)
    expect(r.changed).toBe(false)
    expect(db.updates).toEqual([])
    expect(approved.calls).toEqual([]) // nothing was lacking, so the live store is not even read
  })
  it('an offer with no copy gets one', async () => {
    const r = await ensureOfferContractTexts('t')
    expect(r.texts.custom_apostille.version).toBe(2)
    expect(db.updates).toHaveLength(1)
  })
})

describe('an offer built BEFORE the service had its contract (lines with no type)', () => {
  const untyped = { contract_type: 'custom_apostille', services: [{ name: 'Apostille', pipeline_type: 'Apostille' }], packages: null }
  const catalog = { data: [{ slug: 'apostille', status: 'active', metadata: { pipeline: 'Apostille', contract_type: 'custom_apostille' } }], error: null }
  it('the line gets the service’s own type and is saved, then the wording is frozen', async () => {
    db.offer = { data: untyped, error: null }; db.catalog = catalog
    const r = await ensureOfferContractTexts('t', { refresh: true })
    expect(db.updates[0]).toEqual({ services: [{ name: 'Apostille', pipeline_type: 'Apostille', contract_type: 'custom_apostille' }] })
    expect(db.updates[1]).toHaveProperty('contract_texts')
    expect(r.lines).toBeTruthy()
  })
  it('a service that has no custom type leaves its line alone', async () => {
    db.offer = { data: { ...untyped, contract_type: 'tax_return' }, error: null }
    db.catalog = { data: [{ slug: 'apostille', status: 'active', metadata: { pipeline: 'Apostille', contract_type: 'shipping' } }], error: null }
    const r = await ensureOfferContractTexts('t', { refresh: true })
    expect(db.updates).toEqual([])
    expect(r.lines).toBeUndefined()
  })
})

describe('a database where the migration has not been run', () => {
  it('an offer with a new service is refused in plain words, not with a raw column error', async () => {
    db.updateError = { message: 'column "contract_texts" of relation "offers" does not exist' }
    await expect(ensureOfferContractTexts('t', { refresh: true })).rejects.toThrow(/not switched on yet/)
    db.updateError = null
    db.copy = { data: null, error: { message: 'column offers.contract_texts does not exist' } }
    await expect(ensureOfferContractTexts('t')).rejects.toThrow(/not switched on yet/)
  })
})
