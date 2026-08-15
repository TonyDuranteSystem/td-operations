/**
 * Staff notification: a payment plan carrying a referrer or managed partner
 * has become fully paid in real cash, and nobody has released their
 * commission yet — prompt staff toward the account page's "Release
 * commission" action. Never releases anything itself.
 *
 * WHY A PERIODIC SWEEP, NOT A WRITE-TIME HOOK: an earlier design hooked this
 * into `applyMoneyToInvoice` (the shared payment-confirmation writer). A
 * council review (2026-08-14) found that premise false — two dashboard
 * "Mark Invoice Paid" actions (`app/(dashboard)/payments/invoice-actions.ts`,
 * `app/(dashboard)/finance/actions.ts`) settle a tranche invoice with a raw
 * write that never goes through that function, so a write-time hook would
 * silently miss exactly the manual-confirmation path Antonio asked to cover.
 * A periodic sweep reads plan STATE instead of watching write PATHS, so it
 * cannot miss a future 6th way of confirming a payment either.
 *
 * The decision is a pure function (`decidePlanReferrerNotification`) so the
 * logic is unit-testable without a live offer; the cron route
 * (`app/api/cron/plan-referrer-notify/route.ts`) supplies the real data.
 */

export interface PlanReferrerNotifyInput {
  /** shouldReleasePlanReferrerCredit(offer) — a payable referrer, and no working partner. */
  hasPayableReferrer: boolean
  /** hasWorkingPartnerPayout(offer) — a managed partner with a real payout model. */
  hasWorkingPartner: boolean
  /** offers.commission_released_at IS NOT NULL — already handled, never re-notify. */
  alreadyReleased: boolean
  /** computePlanSettlement(offerToken)?.eligible — every part Paid, real cash covering it. */
  settlementEligible: boolean
}

export type PlanReferrerNotifyDecision =
  | { notify: true; via: "referrer" | "partner" }
  | { notify: false; reason: "already_released" | "no_payable_party" | "not_yet_settled" }

/**
 * Pure decision core. Mirrors the exact predicates the release action itself
 * gates on (`shouldReleasePlanReferrerCredit`/`hasWorkingPartnerPayout` are
 * mutually exclusive by construction — see lib/partners/partner-deal.ts) so
 * this can never recommend notifying about a deal the release button would
 * refuse, or stay silent about one it would accept.
 */
export function decidePlanReferrerNotification(
  input: PlanReferrerNotifyInput,
): PlanReferrerNotifyDecision {
  if (input.alreadyReleased) return { notify: false, reason: "already_released" }
  if (!input.hasPayableReferrer && !input.hasWorkingPartner) {
    return { notify: false, reason: "no_payable_party" }
  }
  if (!input.settlementEligible) return { notify: false, reason: "not_yet_settled" }
  return { notify: true, via: input.hasWorkingPartner ? "partner" : "referrer" }
}

/** The staff-facing message body, worded to match the party actually being paid. */
export function buildPlanReferrerNotifyMessage(params: {
  via: "referrer" | "partner"
  clientName: string
}): string {
  const who = params.via === "partner" ? "the managed partner's payout" : "the referrer's commission"
  return `${params.clientName}'s payment plan is now fully paid — release ${who} on the account page.`
}
