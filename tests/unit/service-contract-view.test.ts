import { describe, it, expect, vi, beforeEach } from 'vitest'

const getEntryById = vi.fn()
const listVersions = vi.fn()
const offersSentByVersion = vi.fn()
vi.mock('@/lib/catalog/framework', () => ({ getEntryById: (...a: unknown[]) => getEntryById(...a) }))
vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: { from: () => ({ select: () => ({ eq: () => ({ order: async () => ({ data: [{ stage_name: 'Request' }, { stage_name: ' ' }, { stage_name: 'Returned' }], error: null }) }) }) }) } }))
vi.mock('@/lib/contracts/service-contract-texts', async (orig) => ({
  ...(await orig<typeof import('@/lib/contracts/service-contract-texts')>()),
  listVersions: (...a: unknown[]) => listVersions(...a),
  offersSentByVersion: (...a: unknown[]) => offersSentByVersion(...a),
}))

import { contractEligibility, staffNameFromEmail, toVersionView, loadContractView, loadServiceFacts } from '@/lib/contracts/service-contract-view'

const entry = (meta: Record<string, unknown> = {}) => ({ id: 'e1', catalog_id: 'services', slug: 'apostille', display_name: 'Apostille', description: 'One document', metadata: { pipeline: 'Apostille', default_price: 150, default_currency: 'USD', ...meta } })
const row = (o: Record<string, unknown>) => ({ id: 'r', service_entry_id: 'e1', contract_type: 'custom_apostille', version: 1, status: 'draft', content: {}, content_hash: 'h1', source: 'claude_draft', note: null, created_by: 'a@b.c', created_at: '2026-10-26T10:00:00Z', approved_by: null, approved_at: null, superseded_at: null, ...o })

beforeEach(() => { getEntryById.mockReset(); listVersions.mockReset(); offersSentByVersion.mockReset(); offersSentByVersion.mockResolvedValue({}) })

describe('contractEligibility — which services can have a contract written here', () => {
  it('a NEW service (its own pipeline, no original contract) can; one that already has its own contract is "new" too', () => {
    expect(contractEligibility(null, 'Apostille')).toEqual({ kind: 'new', note: null })
    expect(contractEligibility('', 'Apostille').kind).toBe('new')
    expect(contractEligibility('custom_apostille', 'Apostille').kind).toBe('new')
  })
  it('the ORIGINAL services (EIN, DBA, Banking Fintech, CMRA, Annual Renewal …) never get one — it would change every offer that contains them', () => {
    for (const p of ['EIN', 'DBA', 'Banking Fintech', 'CMRA Mailing Address', 'Annual Renewal', 'Certificate of Incumbency', ' ein ']) {
      const r = contractEligibility(null, p)
      expect(r.kind, p).toBe('legacy')
      expect(r.note).toMatch(/original services/)
    }
  })
  it('an ORIGINAL service is legacy whatever contract value it carries (e.g. "renewal"): the advice to clear the box would change how its offers are built', () => {
    expect(contractEligibility('renewal', 'Annual Renewal').kind).toBe('legacy')
    expect(contractEligibility('something', 'EIN').kind).toBe('legacy')
    expect(contractEligibility('renewal', 'My New Service').kind).toBe('other') // a NEW service with an unknown type is the typo case
  })
  it('a service with no pipeline (no steps) cannot yet, and the note says what to do', () => {
    expect(contractEligibility(null, null).kind).toBe('no_pipeline')
    expect(contractEligibility('', '  ').note).toMatch(/add them above, save/)
  })
  it('the eight built-in contracts and the full formation / onboarding agreements are "built_in" (nothing to create)', () => {
    expect(contractEligibility('shipping', 'Shipping').kind).toBe('built_in')
    expect(contractEligibility('formation', 'Company Formation').kind).toBe('built_in')
    expect(contractEligibility('onboarding', 'Client Onboarding').note).toMatch(/full “onboarding” agreement/)
  })
  it('anything else is "other" with the instruction to clear the box', () => {
    const r = contractEligibility('apostile', 'Apostille')
    expect(r.kind).toBe('other')
    expect(r.note).toMatch(/clear that box/)
    expect(contractEligibility('Custom_X', 'X').kind).toBe('other')
  })
  it('every Service Catalog row that exists on production today is judged sensibly', () => {
    // the real production catalog (read 2026-10-26): [pipeline, contract_type]
    const prod: Array<[string | null, string | null, string]> = [
      ['Annual Renewal', null, 'legacy'], ['Banking Fintech', null, 'legacy'], ['Certificate of Incumbency', null, 'legacy'], ['CMRA Mailing Address', null, 'legacy'],
      ['DBA', null, 'legacy'], ['EIN', null, 'legacy'], [null, null, 'no_pipeline'],
      ['Company Closure', 'closure', 'built_in'], ['Company Change Name', 'company_change_name', 'built_in'], ['Consulting Call', 'consulting_call', 'built_in'],
      ['EIN Change Name', 'ein_change_name', 'built_in'], ['Company Formation', 'formation', 'built_in'], ['ITIN', 'itin', 'built_in'],
      ['Client Onboarding', 'onboarding', 'built_in'], ['Public Notary', 'public_notary', 'built_in'], ['Shipping', 'shipping', 'built_in'], ['Tax Return', 'tax_return', 'built_in'],
    ]
    for (const [p, t, want] of prod) expect(contractEligibility(t, p).kind, `${p}/${t}`).toBe(want)
  })
})

describe('staffNameFromEmail', () => {
  it('shows a person-like name for an email, and leaves other text alone', () => {
    expect(staffNameFromEmail('antonio.durante@tonydurante.us')).toBe('Antonio Durante')
    expect(staffNameFromEmail('LUCA@x.com')).toBe('Luca')
    expect(staffNameFromEmail('Claude session')).toBe('Claude session')
    expect(staffNameFromEmail(null)).toBe('')
  })
})

describe('loadContractView', () => {
  it('lists versions newest first with offer counts, and says which state the contract is in', async () => {
    getEntryById.mockResolvedValue(entry({ contract_type: 'custom_apostille' }))
    listVersions.mockResolvedValue([row({ id: 'd', version: 2, status: 'draft', content_hash: 'h2' }), row({ id: 'a', version: 1, status: 'approved', content_hash: 'h1', approved_by: 'antonio@x.us', approved_at: '2026-10-26T11:00:00Z' })])
    offersSentByVersion.mockResolvedValue({ 1: 3, 2: 0 })
    const v = await loadContractView('e1')
    expect(v.kind).toBe('new')
    expect(v.note).toBeNull()
    expect(v.state).toBe('approved')
    expect(v.versions.map((x) => [x.version, x.offersSent])).toEqual([[2, 0], [1, 3]])
    expect(v.service.price).toBe(150)
    expect(offersSentByVersion).toHaveBeenCalledWith('custom_apostille', [{ version: 2, hash: 'h2' }, { version: 1, hash: 'h1' }])
  })
  it('a service with only a draft is "draft"; with nothing is "none" and never asks about offers', async () => {
    getEntryById.mockResolvedValue(entry())
    listVersions.mockResolvedValue([row({})])
    expect((await loadContractView('e1')).state).toBe('draft')
    listVersions.mockResolvedValue([])
    expect((await loadContractView('e1')).state).toBe('none')
  })
  it('a built-in or unknown contract type never reads the contract store', async () => {
    getEntryById.mockResolvedValue(entry({ contract_type: 'shipping' }))
    const v = await loadContractView('e1')
    expect(v.kind).toBe('built_in')
    expect(v.versions).toEqual([])
    expect(listVersions).not.toHaveBeenCalled()
  })
  it('refuses something that is not a service', async () => {
    getEntryById.mockResolvedValue({ ...entry(), catalog_id: 'other' })
    await expect(loadContractView('e1')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    getEntryById.mockResolvedValue(null)
    await expect(loadContractView('e1')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('loadServiceFacts', () => {
  it('collects the name, description, price and the steps in order, dropping blank step names', async () => {
    getEntryById.mockResolvedValue(entry())
    expect(await loadServiceFacts('e1')).toEqual({ name: 'Apostille', description: 'One document', price: 150, currency: 'USD', steps: ['Request', 'Returned'] })
  })
})

describe('toVersionView', () => {
  it('exposes the fingerprint and the audit fields', () => {
    expect(toVersionView(row({ status: 'approved', approved_by: 'a@b.c' }) as never, 2)).toMatchObject({ hash: 'h1', offersSent: 2, approvedBy: 'a@b.c', status: 'approved' })
  })
})
