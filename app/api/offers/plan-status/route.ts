/**
 * WS-C: where an account's payment plans stand — the raise surface's data.
 *
 * GET /api/offers/plan-status?account_id=<uuid>
 *
 * Session-gated by the middleware (deliberately NOT in PUBLIC_PREFIXES — this is a staff
 * surface; a client must never see plan mechanics or raise buttons).
 *
 * This is the shared plan-state resolver's first production caller — the account page's plan
 * section, the client schedule and the raise decision all read the SAME answer, which is the
 * disagreement-prevention the resolver was built for. Returns one entry per plan-bearing offer
 * on the account, each part carrying its state, whether it is raisable, and a server-built
 * suggested description so the dialog's prefill uses the sanctioned wording rather than
 * whatever a component composes.
 */

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { planStatusForOffer, computePlanSettlementFromStatus, isRaisable } from "@/lib/offers/payment-plan-state"
import { trancheInvoiceDescription } from "@/lib/offers/payment-plan"
import { hasWorkingPartnerPayout, shouldReleasePlanReferrerCredit } from "@/lib/partners/partner-deal"

export async function GET(req: NextRequest) {
  try {
    const accountId = req.nextUrl.searchParams.get("account_id")
    if (!accountId) {
      return NextResponse.json({ error: "account_id is required" }, { status: 400 })
    }

    // Narrow-cast: payment_plan postdates the deliberately-stale generated types.
    const offersQuery = supabaseAdmin
      .from("offers")
      .select("token, client_name, currency, status, services, payment_plan, referrer_name, referrer_contact_id, referrer_account_id, partner_id, partner_payout_model, commission_released_at" as never)
      .eq("account_id", accountId)
      .not("payment_plan" as never, "is", null) as unknown as {
        then: PromiseLike<{
          data: Array<{
            token: string
            client_name: string | null
            currency: string | null
            status: string | null
            services: unknown
            payment_plan?: unknown
            referrer_name: string | null
            referrer_contact_id: string | null
            referrer_account_id: string | null
            partner_id: string | null
            partner_payout_model: string | null
            commission_released_at: string | null
          }> | null
          error: { message: string } | null
        }>["then"]
      }
    const { data: offers, error } = await offersQuery
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // Superseded/dead offers keep their plan rows for audit but raise nothing.
    const live = (offers ?? []).filter(
      (o) => !["superseded", "cancelled", "declined"].includes(o.status ?? ""),
    )

    const plans = []
    for (const o of live) {
      const status = await planStatusForOffer(o.token)
      if (!status) continue // stored plan no longer validates — the money rails already refuse

      const serviceLabel =
        (Array.isArray(o.services) && (o.services[0] as { name?: string } | undefined)?.name) ||
        "Setup Fee"

      // ⛔ RELEASE ELIGIBILITY (Antonio, 2026-08-13) — deliberately the STRICTER cash+Paid gate,
      // never `status.fullySettled` (which a pure-credit settlement can satisfy with zero real
      // cash — see the doc comment on `PlanSettlement.eligible`). This is read-only information
      // for the account page's "Release commission" button; the actual release action
      // re-verifies eligibility itself rather than trusting anything sent back from this route.
      const settlement = computePlanSettlementFromStatus(o.token, status)
      // ⛔ EFFECTIVE, not raw — and the SAME two functions the release action itself gates on
      // (lib/partners/partner-deal), so this screen can never promise something the button
      // underneath does not do. FIXED 2026-08-14 (bug-hunter, 5th pass): `hasPartner` used to be
      // computed inline here and `hasReferrer` via `shouldRunReferralCredit` — two definitions of
      // "does a partner deal count" that could disagree (a renewal-only partner with no working
      // payout model made BOTH read false, showing neither "Referrer on file" nor "Partner on
      // file" despite a real referrer being owed). `hasWorkingPartnerPayout` /
      // `shouldReleasePlanReferrerCredit` agree by construction.
      const hasPartner = hasWorkingPartnerPayout(o)
      const hasReferrer = shouldReleasePlanReferrerCredit(o)

      plans.push({
        offer_token: o.token,
        client_name: o.client_name,
        currency: o.currency ?? status.plan[0]?.currency ?? "USD",
        fully_settled: status.fullySettled,
        // ⛔ released_at SURFACED (2026-08-14, bug-hunter, 6th pass) — without it the account page
        // had no way to distinguish "never released" from "released already" and kept showing an
        // active Release button forever. Financially harmless (the release route's own atomic
        // claim already refuses a repeat click cleanly) but left staff with zero on-screen signal
        // that anything had happened, on every single reload.
        commission_release: (hasReferrer || hasPartner)
          ? {
              eligible: settlement.eligible,
              total_agreed: settlement.totalAgreed,
              total_received: settlement.totalReceived,
              has_referrer: hasReferrer,
              has_partner: hasPartner,
              released_at: o.commission_released_at,
            }
          : null,
        parts: status.parts.map((p) => ({
          seq: p.part.seq,
          amount: p.part.amount,
          state: p.state,
          raisable: isRaisable(p),
          invoice_number: p.invoice?.invoice_number ?? null,
          superseded_count: p.supersededInvoices.length,
          suggested_description: trancheInvoiceDescription(p.part, status.plan.length, serviceLabel),
        })),
      })
    }

    return NextResponse.json({ plans })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "plan-status failed" },
      { status: 500 },
    )
  }
}
