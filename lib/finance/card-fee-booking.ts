/**
 * Book the card processing fee ONTO an invoice — the money-critical step.
 * dev_task 6ec6872a. Plan v4 §2, approved by both supervisors.
 *
 * Called by each gateway webhook on a confirmed CARD payment, BEFORE the invoice is
 * settled through `applyMoneyToInvoice`. Because the settle credits (total − paid)
 * and CAPS at total, the invoice total must be raised to base+fee here first, or the
 * fee is silently dropped.
 *
 * FAILURE SEMANTICS (the honest substitute for a DB transaction): `bookCardFee` is
 * ALL-OR-THROW. If any write fails it RAISES; the caller must NOT settle and must
 * return non-200 so the gateway retries from a NON-TERMINAL invoice. Every step is
 * idempotent (one fee line via a partial unique index; total = charged is a SET), so
 * the retry heals cleanly. The settle is GATED on this returning ok.
 *
 * Fee is derived from the ACTUAL charged amount, never a recomputed rate. If the
 * charge does not match the invoice base (guard in `deriveFeeFromCharge`), NO fee is
 * booked — the caller settles at base and raises an overage review.
 *
 * `card_fee_rate` / `item_type` / `card_fee_amount` are new columns not yet in the
 * generated Supabase types, so this module uses an `as any`-typed client (repo
 * convention for a new-column escape until types regen).
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { deriveFeeFromCharge, round2 } from '@/lib/payments/card-fee'

export const CARD_FEE_DESCRIPTION = 'Card processing fee'

export interface BookCardFeeResult {
  /** 'booked' = fee line written + total bumped; caller settles then. */
  outcome: 'booked' | 'no_fee' | 'overage'
  base: number
  fee: number
  chargedAmount: number
  invoiceId: string
}

interface ItemRow { amount: number | string | null; item_type: string | null }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => supabaseAdmin as any

/**
 * @param chargedAmount what the gateway actually took (major units).
 */
export async function bookCardFee(
  invoiceId: string,
  chargedAmount: number,
): Promise<BookCardFeeResult> {
  // Load the invoice + its line items. A load failure THROWS (caller retries).
  const { data: payment, error: payErr } = await db()
    .from('payments')
    .select('id, total, amount, card_fee_rate')
    .eq('id', invoiceId)
    .single()
  if (payErr || !payment) throw new Error(`bookCardFee: invoice ${invoiceId} not found: ${payErr?.message ?? ''}`)

  const { data: items, error: itemsErr } = await db()
    .from('payment_items')
    .select('amount, item_type')
    .eq('payment_id', invoiceId)
  if (itemsErr) throw new Error(`bookCardFee: items load failed: ${itemsErr.message}`)

  const base = deriveBase(payment, (items as ItemRow[]) ?? [])
  const derived = deriveFeeFromCharge(base, chargedAmount, payment.card_fee_rate)

  // Base does not match the charge → do not corrupt money. Caller settles at base
  // and raises an overage review (a normal return, NOT a throw).
  if (!derived.valid) {
    return { outcome: 'overage', base, fee: derived.fee, chargedAmount: round2(chargedAmount), invoiceId }
  }
  if (derived.fee <= 0) {
    return { outcome: 'no_fee', base, fee: 0, chargedAmount: round2(chargedAmount), invoiceId }
  }

  // (b) ensure EXACTLY ONE fee line — idempotent via the partial unique index.
  const { data: existingFee } = await db()
    .from('payment_items')
    .select('id')
    .eq('payment_id', invoiceId)
    .eq('item_type', 'fee')
    .maybeSingle()

  if (existingFee?.id) {
    const { error } = await db()
      .from('payment_items')
      .update({ description: CARD_FEE_DESCRIPTION, quantity: 1, unit_price: derived.fee, amount: derived.fee })
      .eq('id', existingFee.id)
    if (error) throw new Error(`bookCardFee: fee-line update failed: ${error.message}`)
  } else {
    // eslint-disable-next-line no-restricted-syntax -- fee-line booking choke-point; runs immediately before applyMoneyToInvoice settles (dev_task 6ec6872a)
    const { error } = await db().from('payment_items').insert({
      payment_id: invoiceId,
      description: CARD_FEE_DESCRIPTION,
      quantity: 1,
      unit_price: derived.fee,
      amount: derived.fee,
      item_type: 'fee',
      sort_order: 999,
    })
    // 23505 = unique_violation → a concurrent retry already inserted it. Not fatal.
    if (error && error.code !== '23505') {
      throw new Error(`bookCardFee: fee-line insert failed: ${error.message}`)
    }
  }

  // (c) raise the invoice total to base+fee + stamp the money-truth. SET (not
  // increment) → idempotent on retry. amount_due is recomputed by the settle.
  const newTotal = round2(base + derived.fee)
  // eslint-disable-next-line no-restricted-syntax -- the fee total-bump choke-point; the subsequent applyMoneyToInvoice settle is what credits it (dev_task 6ec6872a)
  const { error: upErr } = await db()
    .from('payments')
    .update({ total: newTotal, amount: newTotal, card_fee_amount: derived.fee })
    .eq('id', invoiceId)
  if (upErr) throw new Error(`bookCardFee: total bump failed: ${upErr.message}`)

  return { outcome: 'booked', base, fee: derived.fee, chargedAmount: round2(chargedAmount), invoiceId }
}

/** base = sum of NON-fee line items; fallback = the invoice's pre-bump total when it
 *  has no line items. Never "total − fee". Pure — unit-tested. */
export function deriveBase(
  payment: { total: number | string | null; amount: number | string | null },
  items: ItemRow[],
): number {
  const nonFee = items.filter((i) => i.item_type !== 'fee')
  if (nonFee.length > 0) {
    return round2(nonFee.reduce((s, i) => s + (Number(i.amount) || 0), 0))
  }
  return round2(Number(payment.total ?? payment.amount ?? 0))
}
