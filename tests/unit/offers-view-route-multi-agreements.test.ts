import { describe, it, expect, vi, beforeEach } from 'vitest'

const resolveAccess = vi.fn()
const multiEnabled = vi.fn()
vi.mock('@/lib/offers/public-offer-request', () => ({ readOfferRequest: async () => ({ token: 't', code: 'c' }) }))
vi.mock('@/lib/offers/public-offer-access', () => ({ resolvePublicOfferAccess: (...a: unknown[]) => resolveAccess(...a) }))
vi.mock('@/lib/offers/renewal-pass', () => ({ signRenewalPass: async () => 'pass' }))
vi.mock('@/lib/offers/multi-agreements-switch', () => ({ multiAgreementsEnabled: (...a: unknown[]) => multiEnabled(...a) }))

import { POST } from '@/app/api/offers/view/route'

const offerRow = { token: 't', client_name: 'X', access_code: 'secret', services: [{ name: 'A', price: '$1' }], contract_type: 'tax_return' }
const call = async () => (await POST({} as never)).json()

beforeEach(() => { resolveAccess.mockReset(); multiEnabled.mockReset() })

describe('POST /api/offers/view — the "several agreements" flag', () => {
  it('passes the switch value to the page inside the offer, and keeps private fields out', async () => {
    resolveAccess.mockResolvedValue({ kind: 'offer', offer: offerRow, staffPreview: false })
    multiEnabled.mockResolvedValue(false)
    const j = await call()
    expect(j.offer.multi_agreements).toBe(false)
    expect(j.offer.access_code).toBeUndefined()
    expect(j.offer.client_name).toBe('X')
    expect(multiEnabled).toHaveBeenCalledWith({ staffPreview: false })
  })
  it('ON when the switch is on', async () => {
    resolveAccess.mockResolvedValue({ kind: 'offer', offer: offerRow, staffPreview: false })
    multiEnabled.mockResolvedValue(true)
    expect((await call()).offer.multi_agreements).toBe(true)
  })
  it('a staff preview asks for the preview answer', async () => {
    resolveAccess.mockResolvedValue({ kind: 'offer', offer: offerRow, staffPreview: true })
    multiEnabled.mockResolvedValue(true)
    const j = await call()
    expect(multiEnabled).toHaveBeenCalledWith({ staffPreview: true })
    expect(j.staffPreview).toBe(true)
    expect(j.offer.multi_agreements).toBe(true)
  })
  it('a renewal agreement is untouched', async () => {
    resolveAccess.mockResolvedValue({ kind: 'renewal', agreement: { id: 'a1', token: 't' }, staffPreview: false })
    const j = await call()
    expect(j.kind).toBe('renewal')
    expect(multiEnabled).not.toHaveBeenCalled()
  })
  it('an access error is returned as before', async () => {
    resolveAccess.mockResolvedValue({ error: 'nope', status: 403 })
    const res = await POST({} as never)
    expect(res.status).toBe(403)
  })
  it('formation / onboarding offers never read the setting', async () => {
    resolveAccess.mockResolvedValue({ kind: 'offer', offer: { ...offerRow, contract_type: 'formation' }, staffPreview: false })
    const j = await call()
    expect(j.offer.multi_agreements).toBe(false)
    expect(multiEnabled).not.toHaveBeenCalled()
  })
})
