/**
 * Dev job e71d786c — one deal of the 15-minute sweep: when does it issue the referrer's reward by itself, and what does it
 * do in every other case. Uses the REAL plan-status and settlement code (so the strict "paid AND money received" rule is
 * exercised for real); only the database, the release and the staff notes are stand-ins.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { miniDb, type MiniDb } from './helpers/mini-db'
import { computePlanStatus, type TrancheInvoiceRow } from '@/lib/offers/payment-plan-state'

let db: MiniDb
vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: { from: (t: string) => (db as unknown as { from: (t: string) => unknown }).from(t) } }))

let statusToReturn: ReturnType<typeof computePlanStatus> | null = null
vi.mock('@/lib/offers/payment-plan-state', async (orig) => ({
  ...(await orig<typeof import('@/lib/offers/payment-plan-state')>()),
  planStatusForOffer: vi.fn(async () => statusToReturn),
}))

const releaseMock = vi.fn()
vi.mock('@/lib/offers/release-plan-commission', () => ({ releasePlanCommission: (...a: unknown[]) => releaseMock(...a) }))

const lookupMock = vi.fn()
vi.mock('@/lib/operations/find-contact-by-email', () => ({ findContactIdByEmail: (...a: unknown[]) => lookupMock(...a) }))

type NoteArgs = { payment_id: string; account_id?: string | null; contact_id?: string | null; message: string }
const noteLog: Array<{ kind: string } & NoteArgs> = []
let failedNoteExists = false
let emitOutcome: { emitted: boolean; reason?: string; error?: string } = { emitted: true }
vi.mock('@/lib/portal/chat-events', () => ({
  chatEventExists: vi.fn(async (_src: unknown, kind: string) => (kind === 'plan_referrer_auto_release_failed' ? failedNoteExists : false)),
  emitPlanReferrerReadyToReleaseEvent: vi.fn(async (p: Record<string, unknown>) => { noteLog.push({ kind: 'ready', ...(p as NoteArgs) }); return emitOutcome }),
  emitPlanReferrerAutoReleasedEvent: vi.fn(async (p: Record<string, unknown>) => { noteLog.push({ kind: 'auto_released', ...(p as NoteArgs) }); return emitOutcome }),
  emitPlanReferrerAutoReleaseFailedEvent: vi.fn(async (p: Record<string, unknown>) => { noteLog.push({ kind: 'auto_failed', ...(p as NoteArgs) }); return emitOutcome }),
}))

import { processPlanReferrerOffer, type SweepOffer } from '@/lib/notifications/plan-referrer-sweep'

const PLAN = [
  { seq: 1, amount: 1500, currency: 'EUR', trigger: { kind: 'signing' } },
  { seq: 2, amount: 1500, currency: 'EUR', trigger: { kind: 'manual' } },
] as never

const inv = (seq: number, over: Partial<TrancheInvoiceRow> = {}): TrancheInvoiceRow => ({
  id: `inv-${seq}`, invoice_number: `INV-00${seq}`, invoice_status: 'Paid', amount_paid: 1500, amount: 1500,
  tranche_seq: seq, due_date: null, card_fee_amount: null, ...over,
})
const setPlan = (rows: TrancheInvoiceRow[]) => { statusToReturn = computePlanStatus(PLAN, rows) }

const offer = (over: Partial<SweepOffer> = {}): SweepOffer => ({
  token: 'T', client_name: 'Mario Rossi', client_email: 'mario@example.com', account_id: 'acct-client', contact_id: 'contact-client',
  referrer_name: 'Acme LLC', referrer_contact_id: null, referrer_account_id: 'acct-ref',
  partner_id: null, partner_payout_model: null, ...over,
})

const RELEASED_OK = { status: 200, body: { ok: true, already_released: false, message: 'Released $300 to the referrer.', referrer: { attempted: true, ok: true, amount: 300, message: 'Released $300 to the referrer.' } } }

beforeEach(() => {
  db = miniDb({
    payments: [
      { id: 'pay-1', tranche_offer_token: 'T', tranche_seq: 1, invoice_status: 'Paid' },
      { id: 'pay-2', tranche_offer_token: 'T', tranche_seq: 2, invoice_status: 'Paid' },
    ],
  })
  noteLog.length = 0
  failedNoteExists = false
  emitOutcome = { emitted: true }
  releaseMock.mockReset()
  releaseMock.mockResolvedValue(RELEASED_OK)
  lookupMock.mockReset()
  lookupMock.mockResolvedValue(null)
  setPlan([inv(1), inv(2)])
})

const ON = { autoReleaseEnabled: true }

describe('the automatic release', () => {
  it('every part Paid with the money received + a real client as referrer: the reward is issued ONCE and staff are told', async () => {
    const outcome = await processPlanReferrerOffer(offer(), ON)
    expect(outcome).toBe('auto-released')
    expect(releaseMock).toHaveBeenCalledTimes(1)
    expect(releaseMock).toHaveBeenCalledWith('T')
    expect(noteLog).toHaveLength(1)
    expect(noteLog[0]).toMatchObject({ kind: 'auto_released', payment_id: 'pay-2', account_id: 'acct-client' })
    expect(noteLog[0].message).toContain('$300.00')
    expect(noteLog[0].message).toContain('Acme LLC')
  })

  it('a contact-pinned referrer counts as a real client too', async () => {
    expect(await processPlanReferrerOffer(offer({ referrer_account_id: null, referrer_contact_id: 'c-ref' }), ON)).toBe('auto-released')
    expect(releaseMock).toHaveBeenCalledTimes(1)
  })

  it('NOTHING is issued while a part is still unpaid', async () => {
    setPlan([inv(1), inv(2, { invoice_status: 'Sent', amount_paid: 0 })])
    expect(await processPlanReferrerOffer(offer(), ON)).toBe('not_yet_settled')
    expect(releaseMock).not.toHaveBeenCalled()
    expect(noteLog).toEqual([])
  })

  it('NOTHING is issued for a plan whose second part was never raised', async () => {
    setPlan([inv(1)])
    expect(await processPlanReferrerOffer(offer(), ON)).toBe('not_yet_settled')
    expect(releaseMock).not.toHaveBeenCalled()
  })

  it('an offer whose plan cannot be read is left alone', async () => {
    statusToReturn = null
    expect(await processPlanReferrerOffer(offer(), ON)).toBe('not_yet_settled')
    expect(releaseMock).not.toHaveBeenCalled()
  })
})

describe('when it does NOT pay by itself, a person is told (the old behaviour)', () => {
  it('a referrer who is only a typed name: no release, the "ready to release" note', async () => {
    const outcome = await processPlanReferrerOffer(offer({ referrer_account_id: null, referrer_contact_id: null }), ON)
    expect(outcome).toBe('notified (referrer)')
    expect(releaseMock).not.toHaveBeenCalled()
    expect(noteLog.map((n) => n.kind)).toEqual(['ready'])
    expect(noteLog[0].message).toMatch(/release the referrer's commission/)
  })

  it('switch off: no release, the "ready to release" note', async () => {
    expect(await processPlanReferrerOffer(offer(), { autoReleaseEnabled: false })).toBe('notified (referrer)')
    expect(releaseMock).not.toHaveBeenCalled()
    expect(noteLog.map((n) => n.kind)).toEqual(['ready'])
  })

  it('a managed partner: no release, the note names the partner payout', async () => {
    const outcome = await processPlanReferrerOffer(offer({ partner_id: 'p1', partner_payout_model: 'flat_fee' }), ON)
    expect(outcome).toBe('notified (partner)')
    expect(releaseMock).not.toHaveBeenCalled()
    expect(noteLog[0].message).toMatch(/managed partner's payout/)
  })

  it('"already notified" is reported, not an error, when the note exists', async () => {
    emitOutcome = { emitted: false, reason: 'already_emitted' }
    expect(await processPlanReferrerOffer(offer({ referrer_account_id: null }), ON)).toBe('already notified')
  })

  it('a note that cannot be written is an error in the log, never silent', async () => {
    emitOutcome = { emitted: false, reason: 'insert_failed', error: 'boom' }
    expect(await processPlanReferrerOffer(offer({ referrer_account_id: null }), ON)).toBe('error: emit failed — insert_failed: boom')
  })
})

describe('the known gap: every invoice says Paid but the money received is not confirmed', () => {
  it('nothing is released; staff are told to check the bank', async () => {
    setPlan([inv(1), inv(2, { amount_paid: 0 })]) // marked Paid by a matcher that never wrote the money
    const outcome = await processPlanReferrerOffer(offer(), ON)
    expect(outcome).toBe('notified (cash unconfirmed, referrer)')
    expect(releaseMock).not.toHaveBeenCalled()
    expect(noteLog).toHaveLength(1)
    expect(noteLog[0].kind).toBe('ready')
    expect(noteLog[0].message).toMatch(/NOT released automatically/)
  })

  it('a credit-covered part (Paid, no cash) is the same case — never paid out', async () => {
    setPlan([inv(1), inv(2, { amount_paid: null })])
    expect(await processPlanReferrerOffer(offer(), ON)).toBe('notified (cash unconfirmed, referrer)')
    expect(releaseMock).not.toHaveBeenCalled()
  })
})

describe('when the automatic release fails', () => {
  const FAIL = { status: 500, body: { ok: false, already_released: false, message: 'Referrer credit failed: error', referrer: { attempted: true, ok: false, message: 'Referrer commission computed as 0 — nothing to release.' } } }

  it('staff get ONE note with the reason; no "issued" note is written', async () => {
    releaseMock.mockResolvedValue(FAIL)
    const outcome = await processPlanReferrerOffer(offer(), ON)
    expect(outcome).toBe('error: auto release failed — Referrer commission computed as 0 — nothing to release.')
    expect(noteLog.map((n) => n.kind)).toEqual(['auto_failed'])
    expect(noteLog[0].message).toContain('Referrer commission computed as 0')
  })

  it('and the NEXT sweep does not try again by itself', async () => {
    failedNoteExists = true
    expect(await processPlanReferrerOffer(offer(), ON)).toBe('auto_attempt_failed_awaiting_staff')
    expect(releaseMock).not.toHaveBeenCalled()
    expect(noteLog).toEqual([])
  })

  it('a thrown error is left to the caller\'s per-deal isolation and writes no note', async () => {
    releaseMock.mockRejectedValue(new Error('connection dropped'))
    await expect(processPlanReferrerOffer(offer(), ON)).rejects.toThrow('connection dropped')
    expect(noteLog).toEqual([])
  })

  it('"released a moment ago by someone else" is quiet — no second note, no failure', async () => {
    releaseMock.mockResolvedValue({ status: 200, body: { ok: true, already_released: true } })
    expect(await processPlanReferrerOffer(offer(), ON)).toBe('already released')
    expect(noteLog).toEqual([])
  })

  it('a payment voided between the two reads ("not fully paid yet") is a normal race: no note, retried next sweep', async () => {
    releaseMock.mockResolvedValue({ status: 400, body: { error: 'Not fully paid in real cash yet', settlement: { eligible: false } } })
    expect(await processPlanReferrerOffer(offer(), ON)).toBe('not_yet_settled')
    expect(noteLog).toEqual([])
  })

  it('money issued but the FYI note could not be written: said plainly in the log, nothing is undone', async () => {
    emitOutcome = { emitted: false, reason: 'insert_failed', error: 'down' }
    const outcome = await processPlanReferrerOffer(offer(), ON)
    expect(outcome).toBe('auto-released, but the staff note failed — insert_failed: down')
  })
})

describe('who the notes are addressed to', () => {
  it('a deal that began as a lead (no account, no contact on the offer) is found through the canonical email lookup', async () => {
    lookupMock.mockResolvedValue('contact-from-email')
    await processPlanReferrerOffer(offer({ account_id: null, contact_id: null }), ON)
    expect(lookupMock).toHaveBeenCalledWith('mario@example.com')
    expect(noteLog[0]).toMatchObject({ account_id: null, contact_id: 'contact-from-email' })
  })

  it('the lookup is NOT used when the offer already names the company', async () => {
    await processPlanReferrerOffer(offer(), ON)
    expect(lookupMock).not.toHaveBeenCalled()
  })

  it('if the plan looks paid but no Paid invoice can be found, it fails closed rather than inventing an id', async () => {
    db = miniDb({ payments: [] })
    expect(await processPlanReferrerOffer(offer(), ON)).toBe('error: plan looks paid but no Paid tranche invoice was found')
    expect(releaseMock).not.toHaveBeenCalled()
  })
})
