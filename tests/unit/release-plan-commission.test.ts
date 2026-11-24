/**
 * Dev job e71d786c — the release of a payment-plan referrer's reward, now ONE function (`releasePlanCommission`) called by
 * the account page's button AND by the 15-minute sweep. The logic was MOVED out of the route unchanged; these tests pin
 * the gate, the atomic claim, the rollback and the "paid once" guarantees that the automatic release now depends on.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { miniDb, type MiniDb } from './helpers/mini-db'

let db: MiniDb
vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: { from: (t: string) => (db as unknown as { from: (t: string) => unknown }).from(t) } }))

let settlement: Record<string, unknown> | null = null
vi.mock('@/lib/offers/payment-plan-state', () => ({ computePlanSettlement: vi.fn(async () => settlement) }))

const creditMock = vi.fn()
const linkMock = vi.fn()
vi.mock('@/lib/operations/referral', () => ({
  createManualReferralCredit: (...a: unknown[]) => creditMock(...a),
  linkLeadReferralToOffer: (...a: unknown[]) => linkMock(...a),
  // 10% credit note of what was actually billed, as the real helper does for an offer with no terms of its own
  resolveOfferCommission: (_offer: unknown, fee: number) => ({ commissionType: 'credit_note', commissionPct: 10, commissionAmount: fee * 0.1, commissionCurrency: 'USD' }),
}))
vi.mock('@/lib/partners/payout-calc', () => ({ calculatePartnerPayout: vi.fn() }))

const lookupMock = vi.fn()
vi.mock('@/lib/operations/find-contact-by-email', () => ({ findContactIdByEmail: (...a: unknown[]) => lookupMock(...a) }))

import { releasePlanCommission } from '@/lib/offers/release-plan-commission'

const ELIGIBLE = {
  offerToken: 'T', currency: 'EUR', eligible: true,
  parts: [{ seq: 1, settledInCash: true }, { seq: 2, settledInCash: true }],
  totalAgreed: 3000, totalAgreedExFee: 3000, totalReceived: 3000,
}

const offerRow = (over: Record<string, unknown> = {}) => ({
  token: 'T', client_name: 'Mario Rossi', client_email: 'mario@example.com', account_id: null, contact_id: null, lead_id: 'lead-1',
  services: [], referrer_name: 'Acme LLC', referrer_contact_id: null, referrer_account_id: 'acct-ref', referrer_type: 'client',
  referrer_commission_type: null, referrer_commission_pct: null, referrer_agreed_price: null,
  partner_id: null, partner_payout_model: null, partner_payout_rate: null, partner_renewal_payout: null,
  commission_released_at: null, ...over,
})
const claim = () => (db.tables.offers[0] as { commission_released_at: string | null }).commission_released_at

beforeEach(() => {
  db = miniDb({ offers: [offerRow()] })
  settlement = { ...ELIGIBLE }
  creditMock.mockReset()
  creditMock.mockResolvedValue({ created: true, amount: 300 })
  linkMock.mockReset()
  lookupMock.mockReset()
  lookupMock.mockResolvedValue(null)
})

describe('refusals — nothing is claimed, nothing is paid', () => {
  it('an unknown offer', async () => {
    expect(await releasePlanCommission('nope')).toMatchObject({ status: 404 })
    expect(creditMock).not.toHaveBeenCalled()
  })

  it('an offer with no referrer and no partner', async () => {
    db = miniDb({ offers: [offerRow({ referrer_name: null, referrer_account_id: null })] })
    const r = await releasePlanCommission('T')
    expect(r.status).toBe(400)
    expect(String(r.body.error)).toMatch(/nothing to release/)
    expect(claim()).toBeNull()
  })

  it('an offer without a readable plan', async () => {
    settlement = null
    expect((await releasePlanCommission('T')).status).toBe(400)
    expect(creditMock).not.toHaveBeenCalled()
  })

  it('a plan that is not fully paid in real cash: says how many parts are open and never takes the claim', async () => {
    settlement = { ...ELIGIBLE, eligible: false, parts: [{ seq: 1, settledInCash: true }, { seq: 2, settledInCash: false }] }
    const r = await releasePlanCommission('T')
    expect(r.status).toBe(400)
    expect(String(r.body.error)).toContain('1 of 2 part(s) still outstanding')
    expect(r.body.settlement).toBeTruthy()
    expect(claim()).toBeNull()
    expect(creditMock).not.toHaveBeenCalled()
  })
})

describe('the release', () => {
  it('issues exactly 10% of what was really billed, in dollars, and keeps the claim', async () => {
    const r = await releasePlanCommission('T')
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true, already_released: false })
    expect((r.body.referrer as { amount: number }).amount).toBe(300)
    expect(creditMock).toHaveBeenCalledTimes(1)
    const call = creditMock.mock.calls[0][0]
    expect(call).toMatchObject({ referrerAccountId: 'acct-ref', creditAmountUsd: 300, offerToken: 'T', referrerType: 'client' })
    expect(claim()).not.toBeNull()
  })

  it('the commission base is the plan WITHOUT card fees', async () => {
    settlement = { ...ELIGIBLE, totalAgreed: 3150, totalAgreedExFee: 3000 }
    await releasePlanCommission('T')
    expect(creditMock.mock.calls[0][0].creditAmountUsd).toBe(300)
  })

  it('reconciles the lead-sourced pending referral with the offer BEFORE crediting', async () => {
    const order: string[] = []
    linkMock.mockImplementation(async () => { order.push('link') })
    creditMock.mockImplementation(async () => { order.push('credit'); return { created: true, amount: 300 } })
    await releasePlanCommission('T')
    expect(order).toEqual(['link', 'credit'])
    expect(linkMock.mock.calls[0][0]).toMatchObject({ leadId: 'lead-1', referrerAccountId: 'acct-ref', commissionAmount: 300 })
  })

  it('a deal that began as a lead (no account, no contact on the offer): the referred person is found by email and linked', async () => {
    lookupMock.mockResolvedValue('contact-found')
    await releasePlanCommission('T')
    expect(lookupMock).toHaveBeenCalledWith('mario@example.com')
    expect(creditMock.mock.calls[0][0]).toMatchObject({ referredContactId: 'contact-found', referredAccountId: null })
    expect(linkMock.mock.calls[0][0]).toMatchObject({ referredContactId: 'contact-found' })
  })

  it('the email lookup is not used when the offer already names the company', async () => {
    db = miniDb({ offers: [offerRow({ account_id: 'acct-client' })] })
    await releasePlanCommission('T')
    expect(lookupMock).not.toHaveBeenCalled()
    expect(creditMock.mock.calls[0][0]).toMatchObject({ referredAccountId: 'acct-client' })
  })
})

describe('paid once, however many times it is asked', () => {
  it('a second call after a successful release answers "already released" and issues nothing', async () => {
    await releasePlanCommission('T')
    const again = await releasePlanCommission('T')
    expect(again.status).toBe(200)
    expect(again.body).toMatchObject({ ok: true, already_released: true })
    expect(creditMock).toHaveBeenCalledTimes(1)
  })

  it('the button and the sweep at the same moment: exactly one of them pays', async () => {
    const [a, b] = await Promise.all([releasePlanCommission('T'), releasePlanCommission('T')])
    expect(creditMock).toHaveBeenCalledTimes(1)
    expect([a.body.already_released, b.body.already_released].sort()).toEqual([false, true])
  })

  it('the credit step finding a credit that already exists is reported as released, not as a failure', async () => {
    creditMock.mockResolvedValue({ created: false, reason: 'duplicate' })
    const r = await releasePlanCommission('T')
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    expect(String((r.body.referrer as { message: string }).message)).toMatch(/already released/)
  })
})

describe('failures give the claim back so a retry is possible', () => {
  it('a referrer who is only a typed name cannot be credited: failure, claim returned, nothing issued', async () => {
    db = miniDb({ offers: [offerRow({ referrer_account_id: null, referrer_contact_id: null })] })
    const r = await releasePlanCommission('T')
    expect(r.status).toBe(500)
    expect(r.body.ok).toBe(false)
    expect(String((r.body.referrer as { message: string }).message)).toMatch(/free text/)
    expect(claim()).toBeNull()
    expect(creditMock).not.toHaveBeenCalled()
  })

  it('the credit step failing outright: failure, claim returned', async () => {
    creditMock.mockResolvedValue({ created: false, reason: 'error', detail: 'db down' })
    const r = await releasePlanCommission('T')
    expect(r.status).toBe(500)
    expect(String((r.body.referrer as { message: string }).message)).toContain('db down')
    expect(claim()).toBeNull()
  })

  it('an exception in the middle of the release: rolled back, safe to try again', async () => {
    creditMock.mockRejectedValue(new Error('connection dropped'))
    const r = await releasePlanCommission('T')
    expect(r.status).toBe(500)
    expect(String(r.body.error)).toMatch(/rolled back/)
    expect(String(r.body.error)).toContain('connection dropped')
    expect(claim()).toBeNull()
  })

  it('a commission that computes to nothing is refused and the claim is returned', async () => {
    settlement = { ...ELIGIBLE, totalAgreedExFee: 0 }
    const r = await releasePlanCommission('T')
    expect(r.body.ok).toBe(false)
    expect(String((r.body.referrer as { message: string }).message)).toMatch(/nothing to release/)
    expect(claim()).toBeNull()
    expect(creditMock).not.toHaveBeenCalled()
  })
})
