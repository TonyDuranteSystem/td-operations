import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the invoice creator so we can inspect exactly what credit note gets issued.
vi.mock('@/lib/portal/td-invoice', () => ({
  createTDInvoice: vi.fn(),
}))

import { createManualReferralCredit, defaultReferralCreditUsd } from '@/lib/operations/referral'
import { createTDInvoice } from '@/lib/portal/td-invoice'

const invoiceMock = createTDInvoice as unknown as ReturnType<typeof vi.fn>

describe('defaultReferralCreditUsd — 10% of referred setup fee, taken as USD', () => {
  it('computes 10% of the setup-fee total', () => {
    expect(defaultReferralCreditUsd(2000)).toBe(200)   // Azor case: €2000 → $200
    expect(defaultReferralCreditUsd(2500)).toBe(250)
    expect(defaultReferralCreditUsd(3000)).toBe(300)
    expect(defaultReferralCreditUsd(3800)).toBe(380)
  })

  it('rounds to 2 decimals', () => {
    expect(defaultReferralCreditUsd(1234.56)).toBe(123.46)
  })

  it('returns 0 for null / zero / negative (no setup fee on record)', () => {
    expect(defaultReferralCreditUsd(null)).toBe(0)
    expect(defaultReferralCreditUsd(undefined)).toBe(0)
    expect(defaultReferralCreditUsd(0)).toBe(0)
    expect(defaultReferralCreditUsd(-500)).toBe(0)
  })
})

/**
 * Chainable supabase stub for the manual-credit flow. Select chains resolve at
 * .limit() with `existing`; inserts resolve at .single(); updates resolve at
 * the terminal .eq(). Records everything for assertions.
 */
function makeDb(opts: { existing?: Array<Record<string, unknown>>; insertId?: string; insertError?: { message: string } | null } = {}) {
  const state = {
    inserts: [] as Array<{ table: string; payload: Record<string, unknown> }>,
    updates: [] as Array<{ table: string; payload: Record<string, unknown>; col: string; val: unknown }>,
    dedupOr: '' as string,
  }
  const supabase = {
    from(table: string) {
      return {
        select() { return this },
        or(expr: string) { state.dedupOr = expr; return this },
        neq() { return this },
        eq() { return this },
        limit() { return Promise.resolve({ data: opts.existing ?? [] }) },
        insert(payload: Record<string, unknown>) {
          state.inserts.push({ table, payload })
          return {
            select() {
              return {
                single() {
                  if (opts.insertError) return Promise.resolve({ data: null, error: opts.insertError })
                  return Promise.resolve({ data: { id: opts.insertId ?? 'ref-new' }, error: null })
                },
              }
            },
          }
        },
        update(payload: Record<string, unknown>) {
          return {
            eq(col: string, val: unknown) {
              state.updates.push({ table, payload, col, val })
              return Promise.resolve({ error: null })
            },
          }
        },
      }
    },
  }
  return { supabase: supabase as never, state }
}

describe('createManualReferralCredit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    invoiceMock.mockResolvedValue({ paymentId: 'pay-1' })
  })

  it('credits the COMPANY and keeps the person attribution when both ids are given', async () => {
    const { supabase, state } = makeDb({ insertId: 'ref-new' })
    const res = await createManualReferralCredit(
      { referrerContactId: 'c-1', referrerAccountId: 'a-1', referredContactId: 'rc-1', referredName: 'Michele Angelo Puglisi', creditAmountUsd: 200 },
      supabase,
    )

    expect(res).toEqual({ created: true, referralId: 'ref-new', paymentId: 'pay-1', amount: 200 })
    // Referral row carries BOTH ids (person attribution + account for dedup/finance).
    const ins = state.inserts.find(i => i.table === 'referrals')!.payload
    expect(ins.referrer_contact_id).toBe('c-1')
    expect(ins.referrer_account_id).toBe('a-1')
    expect(ins.status).toBe('converted') // flipped to credited by issueReferralCreditNote
    // Credit note lands on the account (contact kept alongside), idempotent per referral.
    const inv = invoiceMock.mock.calls[0][0]
    expect(inv.account_id).toBe('a-1')
    expect(inv.contact_id).toBe('c-1')
    expect(inv.currency).toBe('USD')
    expect(inv.line_items[0].unit_price).toBe(-200)
    expect(inv.skip_credit_netting).toBe(true)
    expect(inv.idempotency_key).toBe('referral-credit:ref-new')
    // issueReferralCreditNote tagged the payment + flipped the referral.
    expect(state.updates).toContainEqual({ table: 'payments', payload: { invoice_status: 'Credit', credit_remaining: 200 }, col: 'id', val: 'pay-1' })
    expect(state.updates).toContainEqual({ table: 'referrals', payload: { status: 'credited', credited_amount: 200 }, col: 'id', val: 'ref-new' })
  })

  it('allows a deliberate PERSONAL credit (contact only, no account)', async () => {
    const { supabase } = makeDb()
    const res = await createManualReferralCredit(
      { referrerContactId: 'c-1', referredContactId: 'rc-1', referredName: 'X', creditAmountUsd: 100 },
      supabase,
    )
    expect(res.created).toBe(true)
    const inv = invoiceMock.mock.calls[0][0]
    expect(inv.account_id).toBeUndefined()
    expect(inv.contact_id).toBe('c-1')
  })

  it('rejects duplicates across scoping (existing credited row blocks a re-add)', async () => {
    const { supabase, state } = makeDb({ existing: [{ id: 'ref-old', status: 'credited', credited_amount: 200, commission_amount: 200 }] })
    const res = await createManualReferralCredit(
      { referrerContactId: 'c-1', referrerAccountId: 'a-1', referredContactId: 'rc-1', referredName: 'X', creditAmountUsd: 200 },
      supabase,
    )
    expect(res).toEqual({ created: false, reason: 'duplicate' })
    expect(invoiceMock).not.toHaveBeenCalled()
    // Dedup matched the referrer by BOTH the account AND the contact id.
    expect(state.dedupOr).toContain('referrer_account_id.eq.a-1')
    expect(state.dedupOr).toContain('referrer_contact_id.eq.c-1')
  })

  it('self-heals a converted-but-uncredited existing row instead of failing (retry after a crash)', async () => {
    const { supabase, state } = makeDb({ existing: [{ id: 'ref-old', status: 'converted', credited_amount: 0, commission_amount: 250 }] })
    const res = await createManualReferralCredit(
      { referrerContactId: 'c-1', referrerAccountId: 'a-1', referredContactId: 'rc-1', referredName: 'X', creditAmountUsd: 250 },
      supabase,
    )
    expect(res).toEqual({ created: true, referralId: 'ref-old', paymentId: 'pay-1', amount: 250, recovered: true })
    // No new referral row — the credit is issued on the EXISTING one, idempotently.
    expect(state.inserts).toHaveLength(0)
    expect(invoiceMock.mock.calls[0][0].idempotency_key).toBe('referral-credit:ref-old')
  })

  it('leaves a recoverable referral row when the credit note fails (no orphan money, retry works)', async () => {
    invoiceMock.mockRejectedValue(new Error('invoice numbering collision'))
    const { supabase, state } = makeDb({ insertId: 'ref-new' })
    const res = await createManualReferralCredit(
      { referrerContactId: 'c-1', referrerAccountId: 'a-1', referredContactId: 'rc-1', referredName: 'X', creditAmountUsd: 200 },
      supabase,
    )
    expect(res).toEqual({ created: false, reason: 'error', detail: 'invoice numbering collision' })
    // The referral row EXISTS (converted, uncredited) — the retry path recovers it.
    expect(state.inserts.find(i => i.table === 'referrals')!.payload.status).toBe('converted')
    // And no payment was tagged (nothing to orphan).
    expect(state.updates.filter(u => u.table === 'payments')).toHaveLength(0)
  })

  it('blocks self-referrals on either scoping', async () => {
    const { supabase } = makeDb()
    expect((await createManualReferralCredit(
      { referrerAccountId: 'a-1', referredAccountId: 'a-1', referredName: 'X', creditAmountUsd: 100 }, supabase,
    )).created).toBe(false)
    expect((await createManualReferralCredit(
      { referrerContactId: 'c-1', referredContactId: 'c-1', referredName: 'X', creditAmountUsd: 100 }, supabase,
    )).created).toBe(false)
  })

  it('validates amount and parties', async () => {
    const { supabase } = makeDb()
    expect(await createManualReferralCredit({ referrerContactId: 'c-1', referredContactId: 'rc-1', referredName: 'X', creditAmountUsd: 0 }, supabase))
      .toEqual({ created: false, reason: 'invalid_amount' })
    expect(await createManualReferralCredit({ referredContactId: 'rc-1', referredName: 'X', creditAmountUsd: 10 }, supabase))
      .toEqual({ created: false, reason: 'missing_party', detail: 'referrer' })
    expect(await createManualReferralCredit({ referrerContactId: 'c-1', referredName: 'X', creditAmountUsd: 10 }, supabase))
      .toEqual({ created: false, reason: 'missing_party', detail: 'referred' })
  })
})
