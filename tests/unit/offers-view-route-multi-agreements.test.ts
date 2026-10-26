import { describe, it, expect, vi, beforeEach } from 'vitest'

const resolveAccess = vi.fn()
const multiEnabled = vi.fn()
const ensureTexts = vi.fn()
const reportError = vi.fn()
vi.mock('@/lib/offers/public-offer-request', () => ({ readOfferRequest: async () => ({ token: 't', code: 'c' }) }))
vi.mock('@/lib/offers/public-offer-access', () => ({ resolvePublicOfferAccess: (...a: unknown[]) => resolveAccess(...a) }))
vi.mock('@/lib/offers/renewal-pass', () => ({ signRenewalPass: async () => 'pass' }))
vi.mock('@/lib/offers/multi-agreements-switch', () => ({ multiAgreementsEnabled: (...a: unknown[]) => multiEnabled(...a) }))
vi.mock('@/lib/offers/contract-texts-snapshot', async (orig) => ({ ...(await orig<typeof import('@/lib/offers/contract-texts-snapshot')>()), ensureOfferContractTexts: (...a: unknown[]) => ensureTexts(...a) }))
vi.mock('@/lib/offers/contract-wording-alert', () => ({ alertMissingContractWording: (...a: unknown[]) => reportError(...a) }))

import { POST } from '@/app/api/offers/view/route'

const offerRow = { token: 't', client_name: 'X', access_code: 'secret', services: [{ name: 'A', price: '$1' }], contract_type: 'tax_return' }
const call = async () => (await POST({} as never)).json()

beforeEach(() => { resolveAccess.mockReset(); multiEnabled.mockReset(); ensureTexts.mockReset(); reportError.mockReset() })

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

  describe('offers that sell a NEW service (frozen contract wording)', () => {
    const customOffer = { ...offerRow, status: 'sent', contract_type: 'custom_apostille', services: [{ name: 'Apostille', price: '$150', contract_type: 'custom_apostille' }] }
    const copy = { custom_apostille: { version: 1, hash: 'h', content: { title: 'T' } } }

    it('an offer that is out (sent) takes — or completes — the frozen copy and returns it', async () => {
      resolveAccess.mockResolvedValue({ kind: 'offer', offer: customOffer, staffPreview: false })
      multiEnabled.mockResolvedValue(false)
      ensureTexts.mockResolvedValue({ texts: copy, missing: [], changed: true })
      const j = await call()
      expect(ensureTexts).toHaveBeenCalledWith('t', { persist: true })
      expect(j.offer.contract_texts).toEqual(copy)
      expect(reportError).not.toHaveBeenCalled()
    })

    it('a DRAFT (a staff preview) shows today’s approved wording but stores NOTHING — the wording is frozen at the real send', async () => {
      resolveAccess.mockResolvedValue({ kind: 'offer', offer: { ...customOffer, status: 'draft' }, staffPreview: true })
      multiEnabled.mockResolvedValue(true)
      ensureTexts.mockResolvedValue({ texts: copy, missing: [], changed: false })
      const j = await call()
      expect(ensureTexts).toHaveBeenCalledWith('t', { persist: false })
      expect(j.offer.contract_texts).toEqual(copy)
    })

    it('a CLIENT looking at a draft (the portal shows drafts; a draft can be signed) is client-facing: the copy is taken now', async () => {
      resolveAccess.mockResolvedValue({ kind: 'offer', offer: { ...customOffer, status: 'draft' }, staffPreview: false })
      multiEnabled.mockResolvedValue(false)
      ensureTexts.mockResolvedValue({ texts: copy, missing: [], changed: true })
      await call()
      expect(ensureTexts).toHaveBeenCalledWith('t', { persist: true })
    })

    it('a staff preview of an offer that is already OUT shows (and completes) what the client has — not today’s live wording', async () => {
      resolveAccess.mockResolvedValue({ kind: 'offer', offer: customOffer, staffPreview: true })
      multiEnabled.mockResolvedValue(true)
      ensureTexts.mockResolvedValue({ texts: copy, missing: [], changed: false })
      await call()
      expect(ensureTexts).toHaveBeenCalledWith('t', { persist: true })
    })

    it('a SIGNED (or paid) offer is never touched: what the client signed stays exactly as it was', async () => {
      for (const status of ['signed', 'paid', 'active', 'completed']) {
        ensureTexts.mockClear()
        resolveAccess.mockResolvedValue({ kind: 'offer', offer: { ...customOffer, status, contract_texts: copy }, staffPreview: false })
        multiEnabled.mockResolvedValue(false)
        const j = await call()
        expect(ensureTexts, status).not.toHaveBeenCalled()
        expect(j.offer.contract_texts, status).toEqual(copy) // whatever is stored is what the page gets
      }
    })

    it('line types filled from the catalog are what the page plans its agreements from', async () => {
      const untyped = { ...customOffer, contract_type: 'custom_apostille', services: [{ name: 'Apostille', pipeline_type: 'Apostille', price: '$150' }] }
      resolveAccess.mockResolvedValue({ kind: 'offer', offer: untyped, staffPreview: false })
      multiEnabled.mockResolvedValue(false)
      const filled = [{ name: 'Apostille', pipeline_type: 'Apostille', price: '$150', contract_type: 'custom_apostille' }]
      ensureTexts.mockResolvedValue({ texts: copy, missing: [], changed: true, lines: { services: filled, packages: null } })
      const j = await call()
      expect(j.offer.services).toEqual(filled)
    })

    it('no approved wording: the page gets no copy, staff are told once (never the client)', async () => {
      resolveAccess.mockResolvedValue({ kind: 'offer', offer: customOffer, staffPreview: false })
      multiEnabled.mockResolvedValue(false)
      ensureTexts.mockResolvedValue({ texts: {}, missing: ['custom_apostille'], changed: false })
      const j = await call()
      expect(j.offer.contract_texts).toEqual({})
      expect(reportError).toHaveBeenCalledTimes(1)
      expect(reportError).toHaveBeenCalledWith('t', ['custom_apostille'])
    })

    it('a staff preview with no approved wording is not reported as a client problem', async () => {
      resolveAccess.mockResolvedValue({ kind: 'offer', offer: { ...customOffer, status: 'draft' }, staffPreview: true })
      multiEnabled.mockResolvedValue(true)
      ensureTexts.mockResolvedValue({ texts: {}, missing: ['custom_apostille'], changed: false })
      await call()
      expect(reportError).not.toHaveBeenCalled()
    })

    it('if preparing the copy FAILS the offer is still returned AND staff are told why (the client sees "being prepared")', async () => {
      resolveAccess.mockResolvedValue({ kind: 'offer', offer: customOffer, staffPreview: false })
      multiEnabled.mockResolvedValue(false)
      ensureTexts.mockRejectedValue(new Error('db down'))
      const j = await call()
      expect(j.kind).toBe('offer')
      expect(j.offer.client_name).toBe('X')
      expect(reportError).toHaveBeenCalledWith('t', ['custom_apostille'], 'db down')
    })

    it('offers without a new service never touch the contract store', async () => {
      resolveAccess.mockResolvedValue({ kind: 'offer', offer: offerRow, staffPreview: false })
      multiEnabled.mockResolvedValue(false)
      await call()
      expect(ensureTexts).not.toHaveBeenCalled()
    })
  })
})
