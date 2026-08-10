/**
 * COMMISSION FOLLOWS THE MONEY — a referrer earns their share of a part when that part is paid.
 *
 * ── THE PROBLEM THIS SOLVES ──────────────────────────────────────────────────────────────
 *
 * Commission is credited ONCE, inside activation, and activation fires when the FIRST payment is
 * confirmed. That is exactly right while one offer means one payment: the money is in, the
 * referrer is paid.
 *
 * With a setup fee paid in parts it becomes a real exposure. Part one arrives, activation runs,
 * and the referrer is credited the full commission on the WHOLE fee — while half the money has
 * not been received. If part two never arrives, TD has paid a commission on revenue it never got,
 * and clawing back an already-issued credit note means editing a document the referrer can see.
 *
 * ── THE RULE ─────────────────────────────────────────────────────────────────────────────
 *
 * Each part carries its own share, credited when that part is paid. The referrer ends up with
 * EXACTLY the same total as before — the timing changes, not the amount — which is the property
 * `splitCommissionAcrossParts` guarantees below and a test pins.
 *
 * ── TWO DECISIONS WORTH READING ───────────────────────────────────────────────────────────
 *
 * 1. THE SHARE IS BASED ON THE PART'S AGREED AMOUNT, NOT ON CASH RECEIVED. A client holding a
 *    paid-call credit pays less cash, but the deal was sold at the same price and the referrer
 *    introduced the same deal. Basing commission on cash would quietly dock the referrer for
 *    someone else's credit.
 *
 * 2. ROUNDING GOES TO THE LAST PART. Three parts of a 2,500 fee at 10% are 83.33 + 83.33 + 83.34
 *    — split evenly and rounded independently they would sum to 249.99 and the referrer would be
 *    a cent short for ever, silently. The last part absorbs the remainder so the total is exact
 *    by construction rather than by luck.
 */

import type { PaymentPlan } from "@/lib/offers/payment-plan"

export interface PartCommission {
  seq: number
  /** The part's own agreed amount — the base this share was computed from. */
  partAmount: number
  /** What the referrer earns when THIS part is paid. */
  commission: number
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Split a whole-deal commission across a plan's parts, in proportion to each part's amount.
 *
 * Guarantees, both pinned by tests:
 *   • the shares sum EXACTLY to `totalCommission` (the last part absorbs any rounding remainder);
 *   • every share is >= 0, so a part can never produce a negative credit.
 *
 * A plan with no parts returns an empty list rather than throwing — the caller decides whether
 * that is an error, and in practice validation has already refused such a plan.
 */
export function splitCommissionAcrossParts(
  plan: PaymentPlan,
  totalCommission: number,
): PartCommission[] {
  if (plan.length === 0) return []

  const total = round2(plan.reduce((s, p) => s + p.amount, 0))
  if (!(total > 0) || !(totalCommission > 0)) {
    // No fee or no commission — every share is zero. Deliberately not an error: a plan with a
    // zero-commission referrer is ordinary, and returning zeros keeps the caller branch-free.
    return plan.map((p) => ({ seq: p.seq, partAmount: p.amount, commission: 0 }))
  }

  const ordered = [...plan].sort((a, b) => a.seq - b.seq)
  const shares: PartCommission[] = []
  let allocated = 0

  ordered.forEach((part, i) => {
    const isLast = i === ordered.length - 1
    // The last part takes whatever is left, so the sum is exact rather than approximately right.
    const commission = isLast
      ? round2(totalCommission - allocated)
      : round2((part.amount / total) * totalCommission)
    allocated = round2(allocated + commission)
    shares.push({ seq: part.seq, partAmount: part.amount, commission: Math.max(commission, 0) })
  })

  return shares
}

/** What the referrer earns when one specific part is paid. Zero if that part is not in the plan. */
export function commissionForPart(
  plan: PaymentPlan,
  totalCommission: number,
  seq: number,
): number {
  return splitCommissionAcrossParts(plan, totalCommission).find((s) => s.seq === seq)?.commission ?? 0
}

/**
 * The share due at SIGNING — i.e. what activation should credit instead of the whole commission.
 *
 * A plan with no signing part credits NOTHING at activation, which is correct rather than a gap:
 * if no money is due at signing, no commission has been earned at signing.
 */
export function commissionDueAtSigning(
  plan: PaymentPlan,
  totalCommission: number,
): number {
  const signing = plan.find((p) => p.trigger.kind === "signing")
  if (!signing) return 0
  return commissionForPart(plan, totalCommission, signing.seq)
}

/**
 * The idempotency key for one part's commission credit.
 *
 * Distinct per part so paying part two credits again rather than being swallowed as a duplicate of
 * part one — and stable per part so a retry of the SAME part cannot double-credit. Both halves
 * matter: the existing whole-deal key would have made part two's credit look like a repeat.
 */
export function trancheCommissionKey(offerToken: string, seq: number): string {
  return `referral-tranche:${offerToken}:${seq}`
}
