/**
 * INTERIM GUARD — a referred deal sold on a payment plan settles its commission BY HAND.
 *
 * Antonio's decision (2026-08-10), and the reasoning is worth keeping because both alternatives
 * are worse:
 *
 *   • BLOCKING the sale would stop him selling a plan to a referred client for a reason the client
 *     could never understand. The deal is fine; only our bookkeeping is not ready.
 *   • LEAVING THE EXISTING PATH LIVE would credit the referrer the FULL commission the moment the
 *     first part is paid — the exposure this workstream found. If the client never pays part two,
 *     a partner has been paid for revenue that never arrived, recoverable only by editing a credit
 *     note they can already see.
 *
 * So: suppress the automatic credit, and surface the deal to a human with everything needed to
 * settle it. Neither overpays, and neither depends on anyone remembering.
 *
 * ── WHY A STAFF ISSUE AND NOT A TASK ──────────────────────────────────────────────────────
 *
 * The CRM task system is not something anyone reads any more. Staff issues are: they surface as the
 * "!" in the Portal Chats Issue tab, which is where the card-fee edge cases already go. Same
 * surface, same shape, so there is one place money problems appear rather than two.
 *
 * `portal_issues` is staff-only — it is not rendered on any client-facing page, so an internal
 * commission note cannot leak to the client or to the referrer.
 *
 * ── FAILURE POSTURE ───────────────────────────────────────────────────────────────────────
 *
 * Raising this must NEVER break activation. By the time it runs the client has signed and paid;
 * an unraised alert is a bookkeeping problem, a thrown error in the activation chain is a stuck
 * client. Every path here swallows and logs.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import type { PaymentPlan } from "@/lib/offers/payment-plan"
import { splitCommissionAcrossParts } from "@/lib/offers/tranche-commission"

const AREA = "referral_commission"

/** Deduped on the offer token: activation can retry, and one deal deserves one card. */
async function alreadyOpenFor(offerToken: string): Promise<boolean> {
  try {
    const { data } = await supabaseAdmin
      .from("portal_issues")
      .select("id")
      .eq("area", AREA)
      .is("resolved_at", null)
      .contains("error_context", { offer_token: offerToken })
      .limit(1)
    return !!data?.length
  } catch {
    // A failed dedup lookup must never stop the alert being raised. A duplicate card is a
    // nuisance; a missing one loses a partner's money.
    return false
  }
}

/**
 * The human-readable body. It carries the AMOUNT and the PARTS, because a card that only says
 * "settle this by hand" sends the reader back to the database to work out what and how much.
 */
export function buildCommissionReviewMessage(input: {
  clientName: string
  referrerName: string
  commissionType: string
  totalCommission: number
  currency: string
  plan: PaymentPlan
}): string {
  const shares = splitCommissionAcrossParts(input.plan, input.totalCommission)
  const lines = shares.map(
    (s) =>
      `  • part ${s.seq} of ${shares.length} — deal ${s.partAmount} ${input.currency}` +
      `, commission ${s.commission} ${input.currency} (earned when that part is paid)`,
  )
  return [
    `Commission for ${input.clientName} must be settled BY HAND — this deal is on a payment plan.`,
    ``,
    `Referrer: ${input.referrerName} (${input.commissionType})`,
    `Total commission: ${input.totalCommission} ${input.currency}`,
    `Suggested split, which nothing has issued:`,
    ...lines,
    ``,
    `Nothing was credited automatically. Per-part accrual is built but not wired: the credit-note`,
    `issuer keys one note per referral and ignores a caller's key, so a second part's credit would`,
    `be silently swallowed and the referrer under-paid. Issue each part's credit yourself as the`,
    `money arrives, or wait for that prerequisite to land.`,
  ].join("\n")
}

/**
 * Suppress-and-surface. Returns true when a card exists after this call (raised now or already
 * open), so the caller can log honestly rather than claim it raised one.
 */
export async function raiseCommissionNeedsHandSettlement(input: {
  offerToken: string
  clientName: string
  referrerName: string
  commissionType: string
  totalCommission: number
  currency: string
  plan: PaymentPlan
  accountId?: string | null
}): Promise<boolean> {
  try {
    if (await alreadyOpenFor(input.offerToken)) return true

    const row = {
      area: AREA,
      error_message: buildCommissionReviewMessage(input),
      error_context: {
        offer_token: input.offerToken,
        referrer_name: input.referrerName,
        commission_type: input.commissionType,
        total_commission: input.totalCommission,
        currency: input.currency,
        parts: splitCommissionAcrossParts(input.plan, input.totalCommission),
        account_id: input.accountId ?? null,
        reason: "payment_plan_commission_not_automated",
      },
      status: "open",
      client_notified: false, // staff-only, never surfaced to the client or the referrer
    } as never

    await supabaseAdmin.from("portal_issues").insert(row)
    return true
  } catch (e) {
    // The client has signed and paid by now. A missing card is a bookkeeping problem; throwing
    // here would strand a real client mid-activation.
    console.error(
      `[tranche-commission] failed to raise hand-settlement card for ${input.offerToken}:`,
      e instanceof Error ? e.message : String(e),
    )
    return false
  }
}
