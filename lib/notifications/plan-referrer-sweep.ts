/**
 * One candidate offer of the 15-minute sweep `/api/cron/plan-referrer-notify` (dev job e71d786c).
 *
 * Lives here, not in the route, so every branch can be unit-tested with the database and the release mocked.
 * The decision itself is pure (`decidePlanReferrerAction`); this file only gathers the facts, runs the one action
 * the decision picked, and answers with a short outcome string for the cron log.
 *
 * What changed on 2026-11-23 (Antonio: "the referrer will get the reward after all payments are done"): when the
 * strict gate says every part of the plan is Paid with the money really received, and the referrer is a real
 * client or company, the sweep now calls the SAME release the account page's button uses
 * (`releasePlanCommission`) instead of only telling staff to click it. Everything the decision does not hand to the
 * automatic path behaves exactly as before: a staff note.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { planStatusForOffer, computePlanSettlementFromStatus } from "@/lib/offers/payment-plan-state"
import { releasePlanCommission } from "@/lib/offers/release-plan-commission"
import { hasWorkingPartnerPayout, shouldReleasePlanReferrerCredit } from "@/lib/partners/partner-deal"
import {
  decidePlanReferrerAction,
  buildPlanReferrerNotifyMessage,
  buildPlanReferrerAutoReleasedMessage,
  buildPlanReferrerAutoReleaseFailedMessage,
  buildPlanReferrerCashUnconfirmedMessage,
} from "@/lib/notifications/plan-referrer-notify"
import {
  chatEventExists,
  emitPlanReferrerReadyToReleaseEvent,
  emitPlanReferrerAutoReleasedEvent,
  emitPlanReferrerAutoReleaseFailedEvent,
  type EmitResult,
} from "@/lib/portal/chat-events"
import { findContactIdByEmail } from "@/lib/operations/find-contact-by-email"

export interface SweepOffer {
  token: string
  client_name: string | null
  client_email: string | null
  account_id: string | null
  contact_id: string | null
  referrer_name: string | null
  referrer_contact_id: string | null
  referrer_account_id: string | null
  partner_id: string | null
  partner_payout_model: string | null
}

/** Did the note get written (or was it already there)? Anything else is a real failure worth logging. */
function noteProblem(res: EmitResult): string | null {
  if (res.emitted || res.reason === "already_emitted") return null
  return `${res.reason ?? "unknown"}${res.error ? `: ${res.error}` : ""}`
}

export async function processPlanReferrerOffer(offer: SweepOffer, options: { autoReleaseEnabled: boolean }): Promise<string> {
  const hasPayableReferrer = shouldReleasePlanReferrerCredit(offer)
  const hasWorkingPartner = hasWorkingPartnerPayout(offer)

  const status = await planStatusForOffer(offer.token)
  const settlement = status ? computePlanSettlementFromStatus(offer.token, status) : null
  const settlementEligible = !!settlement?.eligible
  // The LOOSER state: every part has a live invoice marked Paid (a credit-covered or bank-matched invoice can be
  // Paid with no money recorded). Only used to warn staff — never to pay anything.
  const allPartsMarkedPaid = !!status && status.parts.length > 0 && status.parts.every((p) => p.invoice?.invoice_status === "Paid")

  // The deal's anchor payment: the highest-seq Paid tranche invoice. Deterministic, and it is the id every note about
  // this deal is deduplicated on. Only needed once the deal is at least "all Paid".
  let sourcePaymentId: string | null = null
  if (settlementEligible || allPartsMarkedPaid) {
    const { data: sourcePayment } = await supabaseAdmin
      .from("payments")
      // eslint-disable-next-line no-restricted-syntax -- tranche_offer_token/tranche_seq postdate the generated types for this table.
      .select("id, tranche_seq" as never)
      .eq("tranche_offer_token" as never, offer.token as never)
      .eq("invoice_status", "Paid")
      .order("tranche_seq" as never, { ascending: false })
      .limit(1)
      .maybeSingle() as unknown as { data: { id: string } | null }
    sourcePaymentId = sourcePayment?.id ?? null
  }

  // One automatic attempt per deal: if one already failed, its staff note exists and nothing retries on a loop.
  const autoAttemptAlreadyFailed = sourcePaymentId
    ? await chatEventExists({ table: "payments", id: sourcePaymentId }, "plan_referrer_auto_release_failed")
    : false

  const decision = decidePlanReferrerAction({
    hasPayableReferrer,
    hasWorkingPartner,
    alreadyReleased: false, // the sweep's query already filtered released offers out
    settlementEligible,
    allPartsMarkedPaid,
    referrerPinned: !!(offer.referrer_contact_id || offer.referrer_account_id),
    autoReleaseEnabled: options.autoReleaseEnabled,
    autoAttemptAlreadyFailed,
  })

  if (decision.do === "skip") return decision.reason

  if (!sourcePaymentId) {
    // The deal is at least "all Paid" per the same rows, so a Paid tranche invoice must exist — fail closed rather
    // than write a note against an invented id.
    return "error: plan looks paid but no Paid tranche invoice was found"
  }

  // A lead-originated offer can carry neither an account nor a contact by the time its plan settles (the offer-signed
  // webhook never writes them back). Fall back to the canonical, dedup/tombstone-aware email lookup so the deal is
  // still notifiable — see the cron's original note on this (bug-hunter, 2026-08-14).
  let contactId = offer.contact_id
  if (!offer.account_id && !contactId) contactId = await findContactIdByEmail(offer.client_email)
  const recipients = { account_id: offer.account_id, contact_id: contactId }
  const clientName = offer.client_name || "This client"

  if (decision.do === "notify_ready" || decision.do === "notify_cash_unconfirmed") {
    const message = decision.do === "notify_ready"
      ? buildPlanReferrerNotifyMessage({ via: decision.via, clientName })
      : buildPlanReferrerCashUnconfirmedMessage({ via: decision.via, clientName })
    const res = await emitPlanReferrerReadyToReleaseEvent({ payment_id: sourcePaymentId, ...recipients, message })
    const problem = noteProblem(res)
    if (problem) return `error: emit failed — ${problem}`
    if (!res.emitted) return "already notified"
    return decision.do === "notify_ready" ? `notified (${decision.via})` : `notified (cash unconfirmed, ${decision.via})`
  }

  // decision.do === "auto_release" — the same release the button runs; it re-verifies everything and claims atomically.
  const release = await releasePlanCommission(offer.token)
  const body = release.body as {
    ok?: boolean
    already_released?: boolean
    error?: string
    message?: string
    referrer?: { ok?: boolean; message?: string; amount?: number }
  }

  if (release.status === 200 && body.ok && body.already_released) return "already released"

  // The release re-checks the strict gate itself. If a payment was voided between our read and its read, it answers
  // "not fully paid yet" (400 + the settlement). That is a normal race, not a failure: no note, try again next sweep.
  if (release.status === 400 && "settlement" in body) return "not_yet_settled"

  if (release.status === 200 && body.ok) {
    const message = buildPlanReferrerAutoReleasedMessage({
      clientName,
      referrerName: offer.referrer_name || "the referrer",
      amount: typeof body.referrer?.amount === "number" ? body.referrer.amount : null,
    })
    const res = await emitPlanReferrerAutoReleasedEvent({ payment_id: sourcePaymentId, ...recipients, message })
    const problem = noteProblem(res)
    // The money is already issued at this point; a failed FYI note must be visible in the log but changes nothing else.
    if (problem) return `auto-released, but the staff note failed — ${problem}`
    return "auto-released"
  }

  // The release failed (or was refused). Tell staff ONCE and stop automatic attempts for this deal; the button still works.
  const reason = body.referrer?.message || body.error || body.message || "unknown reason"
  const failedMessage = buildPlanReferrerAutoReleaseFailedMessage({ clientName, reason })
  const res = await emitPlanReferrerAutoReleaseFailedEvent({ payment_id: sourcePaymentId, ...recipients, message: failedMessage })
  const problem = noteProblem(res)
  return problem
    ? `error: auto release failed (${reason}) and the staff note failed too — ${problem}`
    : `error: auto release failed — ${reason}`
}
