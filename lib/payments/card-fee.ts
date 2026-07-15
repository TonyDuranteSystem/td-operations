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
