/**
 * Partner portal — referral progress.
 *
 * A partner's referral is anchored on the OFFER (works for an INDIVIDUAL/contact
 * or a COMPANY/account). The progress stepper is the ONE-TIME ACQUISITION funnel,
 * derived ENTIRELY from real CRM / Finance state — never a manual flag
 * (Antonio 2026-06-25):
 *   - Call done    ← a call_summaries row exists (the CRM call record)
 *   - Offer sent   ← offer.status ∈ {sent, viewed, signed, completed}
 *   - Client signed← offer.status ∈ {signed, completed}
 *   - Client paid  ← offer.status = completed OR a setup payout exists (the
 *                    payout the system auto-creates when Finance confirms payment)
 *
 * The funnel ENDS at "Client paid" (the setup sale). ANNUAL RENEWAL is NOT a
 * stage here: it's a separate, RECURRING billing cycle (R106 — billing, not an
 * SD) that repeats every year the client renews. It is shown separately, one
 * line per year, driven by the renewal payouts (see the My Referrals page) — a
 * recurring cycle can't be a single terminal checkmark in a one-time funnel.
 *
 * Stages are MONOTONIC: a later stage implies all earlier ones (you can't send an
 * offer without a call, can't be paid without signing) — so the stepper never
 * shows a checked stage after an unchecked earlier one.
 */

export type ReferralStage =
  | "call_done"
  | "offer_sent"
  | "client_signed"
  | "client_paid"

export const REFERRAL_STAGES: ReferralStage[] = [
  "call_done",
  "offer_sent",
  "client_signed",
  "client_paid",
]

export interface ReferralProgressInput {
  offerStatus: string | null | undefined
  /** A call_summaries row exists for this referral's lead/contact/account. */
  hasCallSummary: boolean
  /** A non-renewal (setup) payout exists for this referral. */
  hasSetupPayout: boolean
}

export function computeReferralProgress(input: ReferralProgressInput): Record<ReferralStage, boolean> {
  const s = (input.offerStatus || "").toLowerCase()
  const offerSent = ["sent", "viewed", "signed", "completed"].includes(s)
  const clientSigned = ["signed", "completed"].includes(s)
  const clientPaid = s === "completed" || input.hasSetupPayout

  return {
    // call_done is OR'd with offerSent to stay monotonic — an offer can't be sent
    // without a prior call even if no summary was logged.
    call_done: input.hasCallSummary || offerSent || clientPaid,
    offer_sent: offerSent || clientPaid,
    client_signed: clientSigned || clientPaid,
    client_paid: clientPaid,
  }
}

/** The label shown for each stage in the partner portal stepper. */
export const REFERRAL_STAGE_LABELS: Record<ReferralStage, string> = {
  call_done: "Call done",
  offer_sent: "Offer sent",
  client_signed: "Client signed",
  client_paid: "Client paid",
}

/** Whether a payout row is requestable by the partner (auto-created, not yet requested). */
export function isPayoutRequestable(status: string | null | undefined): boolean {
  return (status || "").toLowerCase() === "pending"
}
