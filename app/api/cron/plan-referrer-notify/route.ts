/**
 * CRON: Payment-plan referrer/partner "ready to release" notification.
 *
 * Runs every 15 minutes. Finds payment-plan offers carrying a referrer or
 * managed partner, not yet released, and checks whether the whole plan is
 * NOW genuinely settled in real cash. The first time it sees "yes" for a
 * given deal, it drops a note in that account's What's New feed pointing
 * staff at the existing "Release commission" action. It never releases
 * anything itself, and a deal it has already flagged is never re-flagged.
 *
 * WHY A SWEEP, NOT A HOOK ON THE MONEY-WRITER: see the doc comment on
 * lib/notifications/plan-referrer-notify.ts — a write-time hook was proposed
 * first and rejected by council review (2026-08-14) because two dashboard
 * "Mark Invoice Paid" actions settle a tranche invoice without ever calling
 * the shared payment writer, so a hook there would silently miss exactly the
 * manual-confirmation path this feature exists to cover. Reading plan STATE
 * instead of watching write PATHS is immune to that class of gap by
 * construction — it does not matter which of the four+ ways a payment landed.
 *
 * Reliability, deliberately: each candidate offer is processed inside its own
 * try/catch so one bad row cannot silently take down the rest of the sweep;
 * the emit result is inspected and a failed insert is logged as an error
 * (not swallowed, unlike this codebase's older sibling emitters); the whole
 * run is wrapped and reported to cron_log on both success and failure, the
 * same way every other cron in this codebase is, so a broken sweep is visible
 * rather than silently going quiet.
 *
 * LEAD-ORIGINATED DEALS (bug-hunter, 2026-08-14, review of the built code):
 * an offer created directly from a lead can still carry neither account_id
 * nor contact_id by the time its plan settles — the offer-signed webhook
 * resolves a contact for invoicing but never writes it back onto the offer,
 * and account_id has the identical, already-documented staleness (see
 * migration 20260622-1530's history). This is exactly the population most
 * likely to hit it, since a referral is by definition a new client. When
 * both are missing, this falls back to `findContactIdByEmail` — the
 * codebase's own canonical, dedup/tombstone-aware lookup — rather than
 * hand-rolling a second, unprotected email match (a review-caught mistake:
 * the pattern that looked reusable elsewhere in this codebase is exactly the
 * one without that protection).
 */

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { logCron } from "@/lib/cron-log"
import { computePlanSettlement } from "@/lib/offers/payment-plan-state"
import { hasWorkingPartnerPayout, shouldReleasePlanReferrerCredit } from "@/lib/partners/partner-deal"
import { decidePlanReferrerNotification, buildPlanReferrerNotifyMessage } from "@/lib/notifications/plan-referrer-notify"
import { emitPlanReferrerReadyToReleaseEvent } from "@/lib/portal/chat-events"
import { findContactIdByEmail } from "@/lib/operations/find-contact-by-email"

interface CandidateOffer {
  token: string
  client_name: string | null
  client_email: string | null
  account_id: string | null
  contact_id: string | null
  referrer_name: string | null
  partner_id: string | null
  partner_payout_model: string | null
}

export async function GET(req: NextRequest) {
  const startTime = Date.now()
  const authHeader = req.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    // Candidates: a signed/completed offer, carrying a plan, not yet released,
    // with SOMETHING that could be payable (a referrer name, or a linked
    // partner) — the exact hasWorkingPartnerPayout/shouldReleasePlanReferrerCredit
    // checks run per-row below; this is just a cheap pre-filter.
    // eslint-disable-next-line no-restricted-syntax -- payment_plan/commission_released_at postdate the generated types for this table.
    const offerQuery = supabaseAdmin
      .from("offers")
      .select("token, client_name, client_email, account_id, contact_id, referrer_name, partner_id, partner_payout_model, payment_plan, commission_released_at" as never)
      .in("status", ["signed", "completed"])
      .not("payment_plan" as never, "is", null)
      .is("commission_released_at" as never, null)
      .or("referrer_name.not.is.null,partner_id.not.is.null") as unknown as {
        then: PromiseLike<{ data: (CandidateOffer & { payment_plan: unknown; commission_released_at: string | null })[] | null; error: { message: string } | null }>["then"]
      }
    const { data: offers, error: offersErr } = await offerQuery
    if (offersErr) throw new Error(offersErr.message)

    const results: Array<{ token: string; outcome: string }> = []

    for (const offer of offers ?? []) {
      try {
        const hasPayableReferrer = shouldReleasePlanReferrerCredit(offer)
        const hasWorkingPartner = hasWorkingPartnerPayout(offer)
        const settlement = await computePlanSettlement(offer.token)

        const decision = decidePlanReferrerNotification({
          hasPayableReferrer,
          hasWorkingPartner,
          alreadyReleased: false, // query already filtered this
          settlementEligible: !!settlement?.eligible,
        })

        if (decision.notify === false) {
          results.push({ token: offer.token, outcome: decision.reason })
          continue
        }

        // Idempotency/deep-link anchor: the highest-seq Paid tranche payment for
        // this offer. Deterministic — which paid part is picked doesn't matter,
        // this decision only ever fires once per offer in steady state.
        const { data: sourcePayment } = await supabaseAdmin
          .from("payments")
          // eslint-disable-next-line no-restricted-syntax -- tranche_offer_token/tranche_seq postdate the generated types for this table.
          .select("id, tranche_seq" as never)
          .eq("tranche_offer_token" as never, offer.token as never)
          .eq("invoice_status", "Paid")
          .order("tranche_seq" as never, { ascending: false })
          .limit(1)
          .maybeSingle() as unknown as { data: { id: string } | null }

        if (!sourcePayment) {
          // Eligible per computePlanSettlement but no Paid tranche row found —
          // should not happen (settlement is derived from these same rows), but
          // fail closed rather than emit with a fabricated source id.
          results.push({ token: offer.token, outcome: "error: eligible but no source payment found" })
          continue
        }

        const message = buildPlanReferrerNotifyMessage({
          via: decision.via,
          clientName: offer.client_name || "This client",
        })

        // A lead-originated offer (created before any account/contact link
        // existed) can still have neither by the time its plan settles — the
        // offer-signed webhook resolves a contact for invoicing but never
        // writes it back onto the offer row, and offers.account_id has the
        // same known staleness (see migration 20260622-1530's history). Fall
        // back to the codebase's own canonical, dedup/tombstone-aware email
        // lookup rather than leaving this deal permanently un-notifiable —
        // this is exactly the population most likely to hit it, since a
        // referral is by definition a brand-new client.
        let contactId = offer.contact_id
        if (!offer.account_id && !contactId) {
          contactId = await findContactIdByEmail(offer.client_email)
        }

        const emitResult = await emitPlanReferrerReadyToReleaseEvent({
          payment_id: sourcePayment.id,
          account_id: offer.account_id,
          contact_id: contactId,
          message,
        })

        if (!emitResult.emitted && emitResult.reason !== "already_emitted") {
          // A real failure (missing_recipient / insert_failed) — surfaced, not
          // swallowed, so a broken emit is visible in cron_log rather than the
          // deal just silently never getting flagged.
          results.push({ token: offer.token, outcome: `error: emit failed — ${emitResult.reason}${emitResult.error ? `: ${emitResult.error}` : ""}` })
          continue
        }

        results.push({ token: offer.token, outcome: emitResult.emitted ? `notified (${decision.via})` : "already notified" })
      } catch (rowErr) {
        // Fault isolation: one bad offer must not abort the sweep for the rest.
        results.push({ token: offer.token, outcome: `error: ${rowErr instanceof Error ? rowErr.message : String(rowErr)}` })
      }
    }

    const notified = results.filter((r) => r.outcome.startsWith("notified"))
    const errored = results.filter((r) => r.outcome.startsWith("error"))

    logCron({
      endpoint: "/api/cron/plan-referrer-notify",
      status: "success",
      duration_ms: Date.now() - startTime,
      details: { checked: results.length, notified: notified.length, errored: errored.length, results },
    })

    return NextResponse.json({
      ok: true,
      checked: results.length,
      notified: notified.length,
      errored: errored.length,
      results,
    })
  } catch (err) {
    logCron({
      endpoint: "/api/cron/plan-referrer-notify",
      status: "error",
      duration_ms: Date.now() - startTime,
      error_message: err instanceof Error ? err.message : String(err),
    })
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
