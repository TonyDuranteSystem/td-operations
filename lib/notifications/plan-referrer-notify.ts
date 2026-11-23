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

// ─────────────────────────────────────────────────────────────────────────────
// Automatic release (dev job e71d786c, Antonio 2026-11-23: "the referrer will get the reward after all payments
// are done"). The 15-minute sweep used to ONLY tell staff to click "Release commission". It now issues the
// referrer's reward itself when — and only when — the same strict gate the button uses says every part of the plan
// is Paid with the money really received. Everything below is pure so every branch is unit-tested without a database.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The on/off switch (Vercel setting `PLAN_REFERRER_AUTO_RELEASE`). ON unless someone sets it to off / false / 0 / no /
 * disabled — so a missing or misspelled value can never silently switch the reward off, and the one way to stop the
 * automatic release without a code change is explicit. Off = the sweep behaves exactly as before (staff note only).
 */
export function isPlanReferrerAutoReleaseEnabled(value: string | null | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase()
  return !(v === "off" || v === "false" || v === "0" || v === "no" || v === "disabled")
}

export interface PlanReferrerActionInput {
  /** shouldReleasePlanReferrerCredit(offer) — a referrer name and no working partner. */
  hasPayableReferrer: boolean
  /** hasWorkingPartnerPayout(offer) — a managed partner with a real payout model. */
  hasWorkingPartner: boolean
  /** offers.commission_released_at IS NOT NULL. */
  alreadyReleased: boolean
  /** computePlanSettlement().eligible — every part Paid AND real cash covering it (the strict gate). */
  settlementEligible: boolean
  /** Every part has a live invoice marked Paid — the LOOSER state. True while `settlementEligible` is false = the known gap. */
  allPartsMarkedPaid: boolean
  /** The referrer is a real person/company (contact or account id). A typed name cannot receive a credit note. */
  referrerPinned: boolean
  autoReleaseEnabled: boolean
  /** An earlier automatic attempt failed and staff were already told — never retry on a 15-minute loop. */
  autoAttemptAlreadyFailed: boolean
}

export type PlanReferrerAction =
  | { do: "skip"; reason: "already_released" | "no_payable_party" | "not_yet_settled" | "auto_attempt_failed_awaiting_staff" }
  /** Issue the referrer's reward now (referrer rail only). */
  | { do: "auto_release" }
  /** Today's note: it is paid, a person releases it (managed partner, typed-name referrer, or the switch is off). */
  | { do: "notify_ready"; via: "referrer" | "partner" }
  /** Every invoice shows Paid but the money received is not confirmed on all of them — nothing is paid automatically. */
  | { do: "notify_cash_unconfirmed"; via: "referrer" | "partner" }

/**
 * Pure decision core of the sweep.
 *
 * The automatic release is deliberately narrow: ONLY the referrer's reward, ONLY for a pinned referrer, ONLY when the
 * strict gate is true, ONLY while the switch is on, ONLY once per deal. A managed partner's payout stays a person's
 * action (it needs approval anyway). Whenever the automatic path does not apply, the old behaviour — a staff note — is
 * exactly what happens, so this can only ADD an automatic reward, never remove a prompt that existed.
 */
export function decidePlanReferrerAction(input: PlanReferrerActionInput): PlanReferrerAction {
  if (input.alreadyReleased) return { do: "skip", reason: "already_released" }
  if (!input.hasPayableReferrer && !input.hasWorkingPartner) return { do: "skip", reason: "no_payable_party" }
  const via: "referrer" | "partner" = input.hasWorkingPartner ? "partner" : "referrer"

  if (!input.settlementEligible) {
    // The strict gate can say "no" on a deal that really is paid (the bank matcher sometimes leaves the money field
    // empty on an invoice it did mark Paid). Nothing is paid then — but staff must hear about it, or the reward would
    // be forgotten without a trace.
    return input.allPartsMarkedPaid ? { do: "notify_cash_unconfirmed", via } : { do: "skip", reason: "not_yet_settled" }
  }

  if (via === "referrer" && input.referrerPinned && input.autoReleaseEnabled) {
    return input.autoAttemptAlreadyFailed
      ? { do: "skip", reason: "auto_attempt_failed_awaiting_staff" }
      : { do: "auto_release" }
  }
  return { do: "notify_ready", via }
}

/** Staff FYI: the reward was issued by the sweep. */
export function buildPlanReferrerAutoReleasedMessage(params: {
  clientName: string
  referrerName: string
  amount: number | null
}): string {
  const how = params.amount != null ? `a reward of $${params.amount.toFixed(2)}` : "the reward"
  return `${params.clientName}'s payment plan is now fully paid — ${how} was issued automatically to ${params.referrerName}. Nothing to do.`
}

/** Staff action: the automatic release failed once; the reason is plain text from the release itself. */
export function buildPlanReferrerAutoReleaseFailedMessage(params: { clientName: string; reason: string }): string {
  return `${params.clientName}'s payment plan is now fully paid, but the reward could not be issued automatically (${params.reason}). Fix that, then click "Release commission" on the account page. It will not be tried again by itself.`
}

/** Staff action: every invoice shows Paid but the money received is not confirmed — nothing was released. */
export function buildPlanReferrerCashUnconfirmedMessage(params: { via: "referrer" | "partner"; clientName: string }): string {
  const who = params.via === "partner" ? "the managed partner's payout" : "the referrer's reward"
  return `${params.clientName}'s payment plan shows every invoice as Paid, but the money received is not confirmed on all of them, so ${who} was NOT released automatically. Check the bank; if the money arrived, click "Release commission" on the account page.`
}
