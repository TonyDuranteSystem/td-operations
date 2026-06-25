import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the invoice creator so we can inspect exactly what credit note gets issued.
vi.mock('@/lib/portal/td-invoice', () => ({
  createTDInvoice: vi.fn(),
}))
// referral-utils is pure; no need to mock it.

import { issueReferralCreditNote } from '@/lib/operations/referral'
import { createTDInvoice } from '@/lib/portal/td-invoice'

/** Minimal chainable supabase stub: from(t).update(payload).eq(col, val) → records the call. */
function makeSupabaseStub() {
  const updates: Record<string, { payload: Record<string, unknown>; col: string; val: unknown }> = {}
  const supabase = {
    from(table: string) {
      return {
        update(payload: Record<string, unknown>) {
          return {
            eq(col: string, val: unknown) {
              updates[table] = { payload, col, val }
              return Promise.resolve({ error: null })
            },
          }
        },
      }
    },
  }
  return { supabase, updates }
}

describe('issueReferralCreditNote', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(createTDInvoice as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ paymentId: 'pay-1' })
  })

  it('issues a USD negative credit note with the per-referral idempotency key and skip_credit_netting', async () => {
    const { supabase } = makeSupabaseStub()
    await issueReferralCreditNote(
      { referralId: 'ref-1', referrerAccountId: 'acc-1', amount: 250, currency: 'USD', description: 'Referral reward — 10% credit' },
      supabase as never,
    )

    const input = (createTDInvoice as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(input.account_id).toBe('acc-1')
    expect(input.currency).toBe('USD')
    expect(input.line_items[0].unit_price).toBe(-250) // negative → a credit note
    expect(input.line_items[0].description).toBe('Referral reward — 10% credit')
    expect(input.mark_as_paid).toBe(true)
    expect(input.skip_credit_netting).toBe(true) // a credit note must not net into itself
    expect(input.idempotency_key).toBe('referral-credit:ref-1') // idempotent per referral
  })

  it('tags the payment as Credit with credit_remaining and flips the referral to credited', async () => {
    const { supabase, updates } = makeSupabaseStub()
    const res = await issueReferralCreditNote(
      { referralId: 'ref-1', referrerAccountId: 'acc-1', amount: 250 },
      supabase as never,
    )

    expect(updates.payments).toEqual({ payload: { invoice_status: 'Credit', credit_remaining: 250 }, col: 'id', val: 'pay-1' })
    expect(updates.referrals).toEqual({ payload: { status: 'credited', credited_amount: 250 }, col: 'id', val: 'ref-1' })
    expect(res).toEqual({ paymentId: 'pay-1' })
  })

  it('defaults to USD when no currency is given', async () => {
    const { supabase } = makeSupabaseStub()
    await issueReferralCreditNote({ referralId: 'ref-2', referrerAccountId: 'acc-2', amount: 500 }, supabase as never)
    expect((createTDInvoice as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0].currency).toBe('USD')
  })

  it('uses the absolute amount (never issues a positive/negative-sign mistake)', async () => {
    const { supabase, updates } = makeSupabaseStub()
    await issueReferralCreditNote({ referralId: 'ref-3', referrerAccountId: 'acc-3', amount: -300 }, supabase as never)
    const input = (createTDInvoice as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(input.line_items[0].unit_price).toBe(-300) // -abs(-300)
    expect(updates.payments.payload.credit_remaining).toBe(300) // positive remaining
  })
})
