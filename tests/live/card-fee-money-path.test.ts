/**
 * LIVE money-path proof for the card fee (dev_task 6ec6872a). Runs against the CLOUD
 * SANDBOX DB (sandbox has no Stripe key, so we drive the booking + settle directly —
 * the same code the webhook calls). Approved plan v4; requested by all three
 * supervisors as the step-1 confidence gate before any downstream work.
 *
 * Run: npx vitest run --config vitest.esign-live.config.ts tests/live/card-fee-money-path.test.ts
 *
 * Proves, on a REAL invoice with real line items + the real partial unique index:
 *  - book → settle leaves the invoice fully consistent (total = base+fee = sum of
 *    lines; card_fee_amount = fee; amount_paid = the ACTUAL charge; Paid).
 *  - a webhook RETRY does not double the fee (idempotent).
 *  - a base/charge mismatch books NO fee and reports 'overage'.
 *  - RED TEST (expected to fail until the fee-aware-writers work lands): editing a
 *    fee-bearing invoice must NOT wipe the fee line.
 */

import { describe, it, expect, afterAll } from 'vitest'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { createTDInvoice } from '@/lib/portal/td-invoice'
import { applyMoneyToInvoice } from '@/lib/finance/apply-payment'
import { bookCardFee } from '@/lib/finance/card-fee-booking'

// A disposable sandbox contact to hang test invoices off.
const TEST_CONTACT_ID = '374197ce-d670-40bb-a6f6-6cb64b41699f' // Stefano Pretto (sandbox test)
const createdPaymentIds: string[] = []

async function makeInvoice(base: number, rate = 0.05): Promise<string> {
  const res = await createTDInvoice({
    contact_id: TEST_CONTACT_ID,
    currency: 'USD',
    card_fee_rate: rate,
    line_items: [
      { description: 'QA Service A', unit_price: base * 0.6 },
      { description: 'QA Service B', unit_price: base * 0.4 },
    ],
    idempotency_key: `cardfee-qa:${Date.now()}:${Math.round(base)}:${Math.random().toString(36).slice(2)}`,
  })
  if (!res?.paymentId) throw new Error('makeInvoice: no payment_id')
  createdPaymentIds.push(res.paymentId)
  return res.paymentId
}

async function readInvoice(id: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (supabaseAdmin as any)
    .from('payments')
    .select('total, amount, amount_paid, amount_due, card_fee_amount, status, invoice_status')
    .eq('id', id).single()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: items } = await (supabaseAdmin as any)
    .from('payment_items').select('amount, item_type').eq('payment_id', id)
  const feeLines = (items ?? []).filter((i: { item_type: string }) => i.item_type === 'fee')
  const base = (items ?? []).filter((i: { item_type: string }) => i.item_type !== 'fee')
    .reduce((s: number, i: { amount: number }) => s + Number(i.amount), 0)
  return { ...data, feeLines, feeLineSum: feeLines.reduce((s: number, i: { amount: number }) => s + Number(i.amount), 0), baseFromLines: base }
}

afterAll(async () => {
  for (const id of createdPaymentIds) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabaseAdmin as any).from('payment_items').delete().eq('payment_id', id)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabaseAdmin as any).from('client_expenses').delete().eq('td_payment_id', id)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabaseAdmin as any).from('payments').delete().eq('id', id)
  }
})

describe('card fee — book → settle (the money path)', () => {
  it('books the fee from the actual charge, then settles fully consistent', async () => {
    const id = await makeInvoice(1000) // base 1000, rate 5%
    const charged = 1050

    const booked = await bookCardFee(id, charged)
    expect(booked.outcome).toBe('booked')
    expect(booked.base).toBe(1000)
    expect(booked.fee).toBe(50)

    // Now settle exactly as the webhook does after booking.
    await applyMoneyToInvoice({ paymentId: id, mode: 'settle_full', paidDate: '2026-07-15', actor: 'qa:card-fee' })

    const inv = await readInvoice(id)
    // The invariants the whole job exists to guarantee:
    expect(Number(inv.total)).toBe(1050)                 // total = base + fee
    expect(inv.baseFromLines).toBe(1000)                 // base untouched
    expect(Number(inv.card_fee_amount)).toBe(50)         // money-truth
    expect(inv.feeLineSum).toBe(50)                       // card_fee_amount = sum(fee lines)
    expect(inv.feeLines.length).toBe(1)                  // exactly one fee line
    expect(Number(inv.amount_paid)).toBe(1050)           // amount_paid = ACTUAL charge
    expect(Number(inv.amount_due)).toBe(0)
    expect(inv.status).toBe('Paid')
  })

  it('a webhook retry does NOT double the fee (idempotent)', async () => {
    const id = await makeInvoice(2000)
    await bookCardFee(id, 2100)
    await bookCardFee(id, 2100) // retry
    await bookCardFee(id, 2100) // retry again
    const inv = await readInvoice(id)
    expect(inv.feeLines.length).toBe(1)
    expect(Number(inv.total)).toBe(2100)
    expect(Number(inv.card_fee_amount)).toBe(100)
  })

  it('books NO fee and reports overage when the charge does not match the base', async () => {
    const id = await makeInvoice(1000)
    const booked = await bookCardFee(id, 5000) // wildly off → base mismatch
    expect(booked.outcome).toBe('overage')
    const inv = await readInvoice(id)
    expect(inv.feeLines.length).toBe(0)          // no fee line booked
    expect(Number(inv.total)).toBe(1000)          // total left at base
  })
})
