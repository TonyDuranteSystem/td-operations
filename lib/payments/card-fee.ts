/**
 * Card processing fee — the ONE place the fee math lives (pure, dependency-free).
 *
 * dev_task 6ec6872a. Charge the surcharge that was displayed everywhere but never
 * collected on Stripe. Plan v4, approved by both supervisors.
 *
 * Two distinct jobs, do not confuse them:
 *  - BEFORE payment (display + what we ask the gateway to charge): compute the card
 *    total from the base × (1 + rate) — `computeCardTotal`.
 *  - AT/AFTER payment (booking the fee onto the invoice): derive the fee from what
 *    the gateway ACTUALLY charged, never a recomputed rate — `deriveFeeFromCharge`.
 *    (A recompute can differ from the charge by a rounding unit; the books must match
 *    the money that actually moved.)
 */

/** Fallback when no pinned/configured rate is available. A payment must never break
 *  because a config lookup failed. */
export const DEFAULT_CARD_FEE_RATE = 0.05

/** Clamp a rate to something sane. Garbage config must never price a deal. */
export function normalizeRate(rate: number | string | null | undefined): number {
  const n = typeof rate === 'string' ? Number(rate) : rate
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1) {
    return DEFAULT_CARD_FEE_RATE
  }
  return n
}

/**
 * What is still OWED on an invoice's own amount (card fee excluded): the invoice base
 * minus what was already paid, never below zero, to the cent.
 *
 * A client who wired part of an invoice owes only the rest — the card price and the
 * fee check must both start from THIS number, never from the whole invoice. With
 * nothing paid it returns the whole base, so an ordinary card payment is unchanged.
 * A negative `amountPaid` (credit notes carry one) counts as nothing paid.
 */
export function balanceOwed(
  invoiceBase: number | string | null | undefined,
  amountPaid: number | string | null | undefined,
): number {
  const base = Number(invoiceBase)
  const paid = Number(amountPaid)
  const safeBase = Number.isFinite(base) ? base : 0
  const safePaid = Number.isFinite(paid) && paid > 0 ? paid : 0
  return round2(Math.max(safeBase - safePaid, 0))
}

/**
 * The invoice's own amount WITHOUT the card fee: its total — the figure the client was
 * told and the one the settle caps at (`applyMoneyToInvoice` reads `total ?? amount`) —
 * minus the card fee already booked onto it.
 *
 * Why the TOTAL and not the line items: a discount, a tax line, a payment-plan part
 * (lines for the whole setup fee, total for this part) or a staff edit all make the
 * lines differ from what is actually owed — in production 31 of 382 invoices with
 * lines already do. `card_fee_amount` is written in the SAME update that bumps the
 * total (`bookCardFee`), so `total − card_fee_amount` is right on every retry, also
 * after a crash between the fee line and the bump (then `card_fee_amount` is still
 * empty and the total is still unbumped).
 */
export function invoiceBaseExFee(payment: {
  total?: number | string | null
  amount?: number | string | null
  card_fee_amount?: number | string | null
}): number {
  const total = Number(payment.total ?? payment.amount)
  const fee = Number(payment.card_fee_amount)
  const safeTotal = Number.isFinite(total) ? total : 0
  const safeFee = Number.isFinite(fee) && fee > 0 ? fee : 0
  return round2(Math.max(safeTotal - safeFee, 0))
}

/**
 * The smallest card charge Stripe accepts (0.50 in USD and EUR). A balance whose card
 * price is below this cannot be paid by card — the client is pointed to bank transfer
 * instead of hitting a Stripe error.
 */
export const MIN_CARD_CHARGE = 0.5

export interface CardTotal {
  base: number
  fee: number
  cardTotal: number
  appliedRate: number
}

/**
 * What a card payer is asked to pay: base rounded up by the fee.
 * Rounds the CARD TOTAL, then derives fee as the exact difference, so
 * base + fee === cardTotal always holds. Used for display AND for the amount we
 * hand the gateway at checkout creation.
 */
export function computeCardTotal(base: number, rate?: number | string | null): CardTotal {
  const appliedRate = normalizeRate(rate)
  const safeBase = Number.isFinite(base) && base > 0 ? round2(base) : 0
  const cardTotal = safeBase > 0 ? round2(safeBase * (1 + appliedRate)) : 0
  return { base: safeBase, fee: round2(cardTotal - safeBase), cardTotal, appliedRate }
}

export interface DerivedFee {
  /** True when charged−base is a plausible fee for this base+rate. */
  valid: boolean
  /** The fee to book = charged − base (only meaningful when valid). */
  fee: number
  base: number
  chargedAmount: number
}

/**
 * Derive the fee to BOOK from the amount the gateway actually charged.
 *
 * fee = chargedAmount − base. `valid` is false when that difference is negative or
 * materially larger than the expected fee (base×rate, +1 unit for rounding) — which
 * signals the invoice base does not match what was charged. The caller must NOT book
 * a fee line when invalid; it settles at base and raises an overage review instead
 * (real money sitting at the gateway with no matching invoice line).
 */
export function deriveFeeFromCharge(
  base: number,
  chargedAmount: number,
  rate?: number | string | null,
): DerivedFee {
  const appliedRate = normalizeRate(rate)
  const safeBase = round2(Number(base) || 0)
  const charged = round2(Number(chargedAmount) || 0)
  const fee = round2(charged - safeBase)
  const maxExpectedFee = round2(safeBase * appliedRate) + 1 // +1 major unit slack
  const valid = safeBase > 0 && fee >= 0 && fee <= maxExpectedFee
  return { valid, fee, base: safeBase, chargedAmount: charged }
}

/** Money is 2dp. Keep every derived amount to the cent so fee lines never carry
 *  float dust into the ledger. */
export function round2(n: number): number {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100
}
