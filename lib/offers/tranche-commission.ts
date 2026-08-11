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
import type { PartState } from "@/lib/offers/payment-plan-state"

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

  // ⛔ Council edge (2026-08-11): a TINY last part after rounded-up earlier shares can drive the
  // raw remainder NEGATIVE, and the zero-clamp above then made the SUM EXCEED the whole
  // commission (parts [100, 100, 0.01] at 0.671 → 0.34 + 0.34 + 0 = 0.68). Never-negative and
  // sums-exactly are both promises; when they conflict, the overshoot comes off the LARGEST
  // share, where a cent disappears into rounding rather than distorting a small one.
  const sum = round2(shares.reduce((acc, x) => acc + x.commission, 0))
  const overshoot = round2(sum - totalCommission)
  if (overshoot > 0) {
    const largest = shares.reduce((a, b) => (b.commission > a.commission ? b : a))
    largest.commission = round2(Math.max(largest.commission - overshoot, 0))
  }

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

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  WHEN A SHARE ACCRUES — and the two things that must change before any of this is wired
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── WHAT I VERIFIED IN THE EXISTING CREDIT PATH (not assumed) ──────────────────────────────
 *
 * The referral credit-note issuer HARDCODES its own idempotency key — one per REFERRAL — and it
 * does not accept a key from the caller. It also OVERWRITES the referral's recorded amount rather
 * than adding to it, and flips the referral's status to credited.
 *
 * So the risk is the OPPOSITE of the one worth worrying about. It is not that a partner gets paid
 * twice for one part: it is that paying part two hits the same key, returns part one's existing
 * credit note, and the rest of the commission is NEVER PAID — silently, with the referral looking
 * settled. Under-crediting a partner who is owed money, invisibly.
 *
 * `trancheCommissionKey` above is therefore INERT until the issuer accepts a caller key and the
 * referral row accumulates instead of overwriting. Both are listed on the job as prerequisites.
 * Nothing here is wired, so nothing is currently wrong in production — but the helper must not be
 * mistaken for protection it cannot yet provide.
 *
 * ── ACCRUAL IS ON PAYMENT, NEVER ON RAISING ────────────────────────────────────────────────
 *
 * A share is earned when the money for that part arrives. That single rule answers the dead-part
 * question without a special case: an invoice that was voided, cancelled or turned into a credit
 * note leaves its part with no live invoice at all, which is indistinguishable from never raised —
 * so it never accrued, and there is nothing to reverse. Raise, void, raise again, pay once:
 * exactly one share, because only the payment counted.
 *
 * ── THE GAP THIS DOES NOT CLOSE, STATED RATHER THAN HIDDEN ─────────────────────────────────
 *
 * A part that is PAID and only then refunded or credit-noted has ALREADY accrued, and there is no
 * reversal path anywhere in the referral machinery — the credit note sits on the referrer's account
 * and nets against their next invoice. Reversing it means editing a document the referrer can see.
 * That is out of scope here and belongs with whatever handles client refunds, which does not exist
 * yet either.
 */

/**
 * ⛔ STRUCTURAL INTERLOCK — not a comment, a gate.
 *
 * `false` because the referral credit-note issuer CANNOT yet key a credit per part: it hardcodes
 * one key per referral and ignores whatever a caller passes, and the referral row overwrites its
 * recorded amount instead of accumulating. Wire accrual on top of that and part two's credit is
 * silently swallowed — the referrer under-paid, the referral reading as settled.
 *
 * While this is `false`, `decideAccrual` REFUSES every share, so no amount of wiring can issue one.
 * A future session cannot reach the accrual path without flipping this, and flipping it means
 * reading why it exists. That is the point: the previous version of this protection was a comment,
 * and a comment does not stop anybody.
 *
 * ⛔ FLIP THIS LAST. The order is: job `a5e61a46` lands → delete the authoring refusal in
 * `payment-plan.ts::refusePlanWithReferralPartner` → then flip this. Never before.
 *
 * TO FLIP IT, both must be true — verify them, do not assume:
 *   1. the credit-note issuer accepts a caller-supplied idempotency key and uses it;
 *   2. the referral row ACCUMULATES the credited amount rather than assigning it, and its status
 *      gate does not treat the first part as "done".
 * Tracked as its own job because it touches live money partners can already see.
 */
export const ISSUER_SUPPORTS_PER_PART_KEY = false

export type AccrualRefusal =
  /** The arrangement's commission is not a share of the fee, so it cannot be split by part. */
  | "not_divisible_by_part"
  /** The money for this part has not arrived. */
  | "not_paid_yet"
  /** The credit path cannot yet issue one credit per part — see the interlock above. */
  | "issuer_cannot_key_per_part"

export interface AccrualDecision {
  accrue: boolean
  refusal: AccrualRefusal | null
  /** Plain-English reason, for the staff-facing task when a commission needs a human. */
  reason: string
}

/**
 * Should this part's share be credited now?
 *
 * ⛔ A PRICE-DIFFERENCE ARRANGEMENT IS REFUSED OUTRIGHT, and that is deliberate rather than
 * unfinished. Its commission is not a percentage of the fee — it is the margin between what the
 * partner charged and TD's own base cost for the work. TD incurs that base cost UP FRONT (the
 * filing fees at formation), not in step with the client's parts, so slicing the margin pro-rata
 * would over-credit the partner on part one and could hand them money before TD has covered its
 * own costs. There is no arithmetic that fixes that, because the question is what the partner
 * agreed, not how to divide a number.
 *
 * Same principle as the empty event registry: excluded and loud beats included and wrong. A plan
 * sold under a price-difference arrangement goes to a human, who decides the split for that deal.
 */
export function decideAccrual(
  commissionType: string,
  partState: PartState,
  /**
   * Whether the credit path can key one credit per part. Defaults to the interlock constant, so
   * production behaviour cannot drift by omission.
   *
   * It is a PARAMETER rather than only a constant so the entitlement logic underneath stays
   * provable — a hard-wired `false` would make "is this share earned?" untestable, and an
   * untestable rule is one that rots. Passing `true` is an explicit claim that the prerequisite
   * has landed, which reads as a deliberate act in any diff.
   */
  opts?: { issuerSupportsPerPartKey?: boolean },
): AccrualDecision {
  const issuerReady = opts?.issuerSupportsPerPartKey ?? ISSUER_SUPPORTS_PER_PART_KEY
  if (commissionType === "price_difference") {
    return {
      accrue: false,
      refusal: "not_divisible_by_part",
      reason:
        "This is a price-difference arrangement: the commission is the partner's margin over TD's " +
        "base cost, not a share of the fee, and TD pays that base cost up front rather than in " +
        "step with the client's parts. Decide this partner's split by hand.",
    }
  }

  if (partState !== "paid") {
    return {
      accrue: false,
      refusal: "not_paid_yet",
      reason: "Commission is earned when the money for a part arrives, not when the part is raised.",
    }
  }

  if (!issuerReady) {
    // The share IS earned — this refusal is about our ability to pay it correctly, not about
    // entitlement. The caller's job here is to suppress the automatic credit and surface the deal
    // for hand settlement, which is exactly what the interim guard does.
    return {
      accrue: false,
      refusal: "issuer_cannot_key_per_part",
      reason:
        "This part's share is earned, but the credit path cannot yet issue one credit note per " +
        "part — a second part's credit would be silently swallowed and the referrer under-paid. " +
        "Settle this deal's commission by hand.",
    }
  }

  return { accrue: true, refusal: null, reason: "This part is paid, so its share is earned." }
}
