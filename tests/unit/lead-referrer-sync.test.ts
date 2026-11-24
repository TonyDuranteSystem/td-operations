/**
 * Dev job 4bc21d49 — the lead's referrer, and the offer → lead sync.
 *
 * Real incident: an offer for a referred lead was saved with NO referrer (the author typed the name in the
 * referrer search box but never clicked the result), so the lead page showed nothing and the referrer's own
 * Referrals list stayed empty. Two fixes are pinned here: the typed-but-not-picked guard, and the offer → lead
 * sync that goes through the SAME routine as the lead page's Referrer box.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { miniDb } from './helpers/mini-db'

const notifyCalls: Array<Record<string, unknown>> = []
vi.mock('@/lib/operations/referral-notify', () => ({
  notifyReferrerLinked: vi.fn(async (p: Record<string, unknown>) => { notifyCalls.push(p) }),
}))
// The money module imports the invoice creator; this suite never creates an invoice.
vi.mock('@/lib/portal/td-invoice', () => ({ createTDInvoice: vi.fn() }))
vi.mock('@/lib/offers/payment-plan-state', () => ({ computePlanSettlement: vi.fn() }))
vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: {} }))

import { decideLeadReferrerSync, setLeadReferrer, syncOfferReferrerToLead } from '@/lib/operations/lead-referrer'
import { referrerDraftProblem, referrerReviewLabel } from '@/lib/offers/referrer-draft'

// The in-memory stand-in is not the typed client; `never` fits the helper's `supabase` option.
const asClient = (db: unknown) => db as never

const HL_ACCOUNT = 'acct-hl'
const LEAD = 'lead-lorenzo'

function seed(leadRef: { name?: string | null; contact?: string | null; account?: string | null } = {}, extra: Record<string, Record<string, unknown>[]> = {}) {
  return miniDb({
    leads: [{ id: LEAD, full_name: 'Lorenzo Bertolin', email: 'lorenzo@example.com', referrer_name: leadRef.name ?? null, referrer_contact_id: leadRef.contact ?? null, referrer_account_id: leadRef.account ?? null }],
    contacts: [{ id: 'c-hamza', email: 'hamza@example.com' }],
    referrals: [],
    ...extra,
  })
}

beforeEach(() => { notifyCalls.length = 0 })

describe('referrerDraftProblem — typed but never picked', () => {
  it('refuses a name typed in the search box when nobody was picked, and says what to do', () => {
    const msg = referrerDraftProblem({ contactId: null, accountId: null }, 'HL International')
    expect(msg).toContain('HL International')
    expect(msg).toContain('NO referrer')
    expect(msg).toMatch(/click a result/i)
  })
  it('lets it through once somebody is picked (company or person)', () => {
    expect(referrerDraftProblem({ contactId: null, accountId: 'a' }, 'HL')).toBeNull()
    expect(referrerDraftProblem({ contactId: 'c', accountId: null }, 'Ha')).toBeNull()
  })
  it('lets it through when nothing (or one stray character) is typed', () => {
    expect(referrerDraftProblem({ contactId: null, accountId: null }, '')).toBeNull()
    expect(referrerDraftProblem({ contactId: null, accountId: null }, '   ')).toBeNull()
    expect(referrerDraftProblem({ contactId: null, accountId: null }, 'H')).toBeNull()
  })
})

describe('referrerReviewLabel — what the review window shows', () => {
  it('says None when there is no referrer', () => {
    expect(referrerReviewLabel({ name: '', contactId: null, accountId: null })).toBe('None')
    expect(referrerReviewLabel({ name: '   ', contactId: null, accountId: null })).toBe('None')
  })
  it('shows a picked client by name', () => {
    expect(referrerReviewLabel({ name: 'HL International LLC', contactId: null, accountId: 'a' })).toBe('HL International LLC')
  })
  it('flags a typed name that is not linked to any client', () => {
    expect(referrerReviewLabel({ name: 'Instagram', contactId: null, accountId: null })).toContain('not linked')
  })
})

describe('decideLeadReferrerSync', () => {
  const none = { referrer_name: null, referrer_contact_id: null, referrer_account_id: null }
  it('sets it when the lead has no referrer', () => {
    expect(decideLeadReferrerSync(none, { contactId: null, accountId: HL_ACCOUNT })).toEqual({ action: 'set' })
  })
  it('sets it when the lead holds only a typed name (a picked client is the stronger version of it)', () => {
    expect(decideLeadReferrerSync({ ...none, referrer_name: 'amici' }, { contactId: 'c', accountId: null })).toEqual({ action: 'set' })
  })
  it('does nothing when the lead already points at the same company', () => {
    expect(decideLeadReferrerSync({ ...none, referrer_account_id: HL_ACCOUNT }, { contactId: null, accountId: HL_ACCOUNT })).toEqual({ action: 'same' })
  })
  it('does nothing when the lead already points at the same person, even if the credit company differs', () => {
    expect(decideLeadReferrerSync({ ...none, referrer_contact_id: 'c1', referrer_account_id: 'A2' }, { contactId: 'c1', accountId: 'A1' })).toEqual({ action: 'same' })
  })
  it('never overwrites a lead pinned to someone else — reports the conflict with the lead\'s name', () => {
    expect(decideLeadReferrerSync({ referrer_name: 'Other LLC', referrer_contact_id: null, referrer_account_id: 'other' }, { contactId: null, accountId: HL_ACCOUNT }))
      .toEqual({ action: 'conflict', leadReferrerName: 'Other LLC' })
  })
  it('NEVER copies a typed name (no linked client) onto the lead', () => {
    expect(decideLeadReferrerSync(none, { contactId: null, accountId: null })).toEqual({ action: 'skip', reason: 'not_pinned' })
  })
})

describe('setLeadReferrer — the one routine behind the lead page box and offer creation', () => {
  it('writes the lead, creates ONE pending referral and tells the referrer once', async () => {
    const db = seed()
    const res = await setLeadReferrer(LEAD, { referrerName: 'HL International LLC', contactId: null, accountId: HL_ACCOUNT }, { supabase: asClient(db), awaitNotify: true })
    expect(res.ok).toBe(true)
    const lead = db.tables.leads[0]
    expect(lead.referrer_name).toBe('HL International LLC')
    expect(lead.referrer_account_id).toBe(HL_ACCOUNT)
    expect(db.tables.referrals).toHaveLength(1)
    expect(db.tables.referrals[0]).toMatchObject({ referred_lead_id: LEAD, referrer_account_id: HL_ACCOUNT, status: 'pending', referrer_type: 'client' })
    expect(notifyCalls).toHaveLength(1)
    expect(notifyCalls[0]).toMatchObject({ referrerAccountId: HL_ACCOUNT, referredLeadId: LEAD })
  })

  it('setting the same referrer again creates no second referral and no second message', async () => {
    const db = seed()
    const input = { referrerName: 'HL International LLC', contactId: null, accountId: HL_ACCOUNT }
    await setLeadReferrer(LEAD, input, { supabase: asClient(db), awaitNotify: true })
    const second = await setLeadReferrer(LEAD, input, { supabase: asClient(db), awaitNotify: true })
    expect(second.ok && second.referralCreated).toBeFalsy()
    expect(db.tables.referrals).toHaveLength(1)
    expect(notifyCalls).toHaveLength(1)
  })

  it('clearing the referrer cancels the pending referral and leaves a converted one alone', async () => {
    const db = seed({ name: 'HL', account: HL_ACCOUNT }, {
      referrals: [
        { id: 'r-pending', referred_lead_id: LEAD, referrer_account_id: HL_ACCOUNT, referrer_contact_id: null, status: 'pending' },
        { id: 'r-done', referred_lead_id: LEAD, referrer_account_id: 'x', referrer_contact_id: null, status: 'credited' },
      ],
    })
    const res = await setLeadReferrer(LEAD, { referrerName: null, contactId: null, accountId: null }, { supabase: asClient(db) })
    expect(res.ok && res.referralCancelled).toBe(1)
    expect(db.tables.referrals.find((r) => r.id === 'r-pending')?.status).toBe('cancelled')
    expect(db.tables.referrals.find((r) => r.id === 'r-done')?.status).toBe('credited')
    expect(db.tables.leads[0].referrer_account_id).toBeNull()
  })

  it('a lead that does not exist is reported, nothing is created', async () => {
    const db = seed()
    const res = await setLeadReferrer('nope', { referrerName: 'X', contactId: null, accountId: HL_ACCOUNT }, { supabase: asClient(db) })
    expect(res).toMatchObject({ ok: false, reason: 'lead_not_found' })
    expect(db.tables.referrals).toHaveLength(0)
    expect(notifyCalls).toHaveLength(0)
  })

  it('the notification can be switched off, and the referral is still created', async () => {
    const db = seed()
    await setLeadReferrer(LEAD, { referrerName: 'HL', contactId: null, accountId: HL_ACCOUNT }, { supabase: asClient(db), notify: false })
    expect(db.tables.referrals).toHaveLength(1)
    expect(notifyCalls).toHaveLength(0)
  })

  it('a referrer who is the lead themselves is refused a referral but the lead is still saved (self-referral guard)', async () => {
    const db = seed({}, { contacts: [{ id: 'c-self', email: 'lorenzo@example.com' }] })
    const res = await setLeadReferrer(LEAD, { referrerName: 'Lorenzo', contactId: 'c-self', accountId: null }, { supabase: asClient(db) })
    expect(res.ok && res.referralSkip).toBe('self_referral')
    expect(db.tables.referrals).toHaveLength(0)
    expect(notifyCalls).toHaveLength(0)
  })
})

describe('syncOfferReferrerToLead — what creating an offer does to the lead', () => {
  const offerRef = { referrerName: 'HL International LLC', contactId: null, accountId: HL_ACCOUNT }

  it('lead without a referrer: it is set, the pending referral exists and the referrer is told', async () => {
    const db = seed()
    const r = await syncOfferReferrerToLead(LEAD, offerRef, { supabase: asClient(db) })
    expect(r.outcome).toBe('set')
    expect(db.tables.leads[0].referrer_account_id).toBe(HL_ACCOUNT)
    expect(db.tables.referrals).toHaveLength(1)
    expect(notifyCalls).toHaveLength(1)
  })

  it('lead already pinned to the same referrer: nothing changes, nobody is told again', async () => {
    const db = seed({ name: 'HL International LLC', account: HL_ACCOUNT })
    const r = await syncOfferReferrerToLead(LEAD, offerRef, { supabase: asClient(db) })
    expect(r.outcome).toBe('same')
    expect(db.tables.referrals).toHaveLength(0)
    expect(notifyCalls).toHaveLength(0)
  })

  it('lead pinned to someone else: NOT overwritten, a plain warning names both', async () => {
    const db = seed({ name: 'Other LLC', account: 'acct-other' })
    const r = await syncOfferReferrerToLead(LEAD, offerRef, { supabase: asClient(db) })
    expect(r.outcome).toBe('conflict')
    expect(r.warning).toContain('Other LLC')
    expect(r.warning).toContain('HL International LLC')
    expect(r.warning).toMatch(/only ONE referrer is credited/)
    expect(db.tables.leads[0].referrer_account_id).toBe('acct-other')
    expect(db.tables.referrals).toHaveLength(0)
    expect(notifyCalls).toHaveLength(0)
  })

  it('a typed name with no linked client never reaches the lead', async () => {
    const db = seed()
    const r = await syncOfferReferrerToLead(LEAD, { referrerName: 'Instagram', contactId: null, accountId: null }, { supabase: asClient(db) })
    expect(r.outcome).toBe('skipped')
    expect(db.tables.leads[0].referrer_name).toBeNull()
    expect(db.tables.referrals).toHaveLength(0)
  })

  it('a failing database becomes a warning, never an exception (the offer already exists)', async () => {
    const db = miniDb({ leads: [{ id: LEAD, full_name: 'L', email: 'l@x.com', referrer_name: null, referrer_contact_id: null, referrer_account_id: null }], referrals: [] }, { failOps: { 'leads:update': 'boom' } })
    const r = await syncOfferReferrerToLead(LEAD, offerRef, { supabase: asClient(db) })
    expect(r.outcome).toBe('failed')
    expect(r.warning).toContain('boom')
    expect(r.warning).toMatch(/Referrer box/)
  })

  it('a lead that cannot be found is skipped quietly', async () => {
    const db = seed()
    const r = await syncOfferReferrerToLead('missing', offerRef, { supabase: asClient(db) })
    expect(r.outcome).toBe('skipped')
  })
})
