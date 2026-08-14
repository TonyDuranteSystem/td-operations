/**
 * Release a referrer's commission AND/OR a managed partner's payout on a payment-plan deal —
 * the single human-confirmed action that replaces automatic per-part accrual (Antonio,
 * 2026-08-13). Partners get the IDENTICAL treatment to client referrers (Antonio's ruling 3) —
 * both rails are attempted here, independently, exactly as activation itself always ran them as
 * two separate rails (Step 3.5 client-referral, Step 3.6 partner-payout) that can both fire for
 * the same offer.
 *
 * POST /api/offers/release-commission
 *   body: { offer_token: string }
 *
 * Nothing is credited until this route is called, and each rail credits EXACTLY ONCE per offer:
 *  - the referrer rail reuses `createManualReferralCredit`'s existing dedup + idempotency;
 *  - the partner rail refuses to insert a second `referral_payouts` row for the same offer token
 *    (excluding a `rejected` one, mirroring the referrer side's own "cancelled doesn't block a
 *    fresh attempt" rule).
 *
 * ⛔ ELIGIBILITY IS RE-VERIFIED HERE, SERVER-SIDE, ALWAYS — never trust a client-supplied
 * "eligible" flag. `/api/offers/plan-status` returns eligibility for DISPLAY only; this route
 * recomputes it fresh from the database before issuing anything.
 *
 * The partner payout is created at `status: 'pending'` — the SAME starting status the
 * non-suppressed activation path already uses — so the EXISTING, unmodified approve/mark-paid
 * flow in `app/api/crm/admin-actions/partner-actions/route.ts` picks it up with no changes.
 * Verified before building this: that flow's `approve_payout` case only accepts
 * `pending`/`manual_review`/`requested` — inventing a different starting status here would have
 * made a released partner payout permanently unapprovable.
 *
 * Dashboard-only, same gate as the sibling manual-credit action (`/api/referral/[id]/issue-credit`).
 */

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isDashboardUser } from "@/lib/auth"
import { computePlanSettlement, type PlanSettlement } from "@/lib/offers/payment-plan-state"
import { createManualReferralCredit, resolveOfferCommission, type ManualReferralResult } from "@/lib/operations/referral"
import { calculatePartnerPayout } from "@/lib/partners/payout-calc"

export const dynamic = "force-dynamic"

interface OfferRow {
  token: string
  client_name: string | null
  account_id: string | null
  contact_id: string | null
  services: unknown
  referrer_name: string | null
  referrer_contact_id: string | null
  referrer_account_id: string | null
  referrer_type: string | null
  partner_id: string | null
  partner_payout_model: string | null
  partner_payout_rate: number | string | null
}

async function releaseReferrerCredit(
  offer: OfferRow,
  offerToken: string,
  settlement: PlanSettlement,
): Promise<{ attempted: boolean; ok: boolean; message: string; amount?: number }> {
  const hasReferrer = Boolean(offer.referrer_name || offer.referrer_contact_id || offer.referrer_account_id)
  if (!hasReferrer) return { attempted: false, ok: true, message: "" }

  if (!offer.referrer_contact_id && !offer.referrer_account_id) {
    // The exact free-text-only case this session's own investigation kept surfacing: a credit
    // note can only be posted against a REAL contact or account, never a bare string.
    return {
      attempted: true,
      ok: false,
      message: `Referrer ("${offer.referrer_name}") is free text with no linked client or company — ` +
        "open the offer and pick the referrer from the Referrer field before releasing.",
    }
  }

  // Commission basis: the REAL total actually billed and cash-verified across every part —
  // grounded in the same rows `settlement.eligible` was just proven true against, not a
  // separately re-derived offer gross that could theoretically disagree with what was truly
  // collected.
  const commission = resolveOfferCommission(
    { referrer_commission_type: null, referrer_type: offer.referrer_type, referrer_commission_pct: null, referrer_agreed_price: null },
    settlement.totalAgreed,
  )
  // ⛔ ROUNDED HERE — calculateCommission (lib/referral-utils.ts) applies none itself (verified
  // by reading it; a percentage of an odd total can produce a long decimal tail otherwise).
  const commissionAmount = Math.round(commission.commissionAmount * 100) / 100

  const result: ManualReferralResult = await createManualReferralCredit(
    {
      referrerContactId: offer.referrer_contact_id,
      referrerAccountId: offer.referrer_account_id,
      referredContactId: offer.contact_id,
      referredAccountId: offer.account_id,
      referrerType: offer.referrer_type === "partner" ? "partner" : "client",
      referredName: offer.client_name || offerToken,
      creditAmountUsd: commissionAmount,
      note: `Released — payment plan fully paid in full (offer ${offerToken}, ${settlement.totalAgreed} ${settlement.currency} total)`,
    },
    supabaseAdmin,
  )

  if (!result.created) {
    // Same cast the sibling caller (app/api/referral/manual/route.ts) already needed for this
    // exact union — `created: false`'s member type does not narrow cleanly here.
    const fail = result as unknown as { reason: string; detail?: string }
    if (fail.reason === "duplicate") return { attempted: true, ok: true, message: "Referrer credit already released — no second credit was issued." }
    return { attempted: true, ok: false, message: `Referrer credit failed: ${fail.reason}${fail.detail ? ` — ${fail.detail}` : ""}` }
  }
  const ok = result as unknown as { amount: number }
  return { attempted: true, ok: true, message: `Released $${ok.amount} to the referrer.`, amount: ok.amount }
}

async function releasePartnerPayout(
  offer: OfferRow,
  offerToken: string,
  settlement: PlanSettlement,
): Promise<{ attempted: boolean; ok: boolean; message: string; amount?: number }> {
  const hasPartner = Boolean(offer.partner_id && offer.partner_payout_model && offer.partner_payout_model !== "none")
  if (!hasPartner) return { attempted: false, ok: true, message: "" }

  // Dedup: refuse a second payout for this offer. `rejected` does NOT block a fresh attempt —
  // same convention as the referrer rail treating `cancelled` as non-blocking.
  const { data: existing } = await supabaseAdmin
    .from("referral_payouts")
    .select("id, status")
    .eq("offer_token" as never, offerToken as never)
    .neq("status", "rejected")
    .limit(1)
  if (existing && existing.length > 0) {
    return { attempted: true, ok: true, message: "Partner payout already released — no second payout was created." }
  }

  const { data: partnerRow } = await supabaseAdmin
    .from("client_partners")
    .select("td_base_costs")
    .eq("id", offer.partner_id as string)
    .single()

  const offerServices = Array.isArray(offer.services) ? (offer.services as Array<Record<string, unknown>>) : []
  const primarySlug = (offerServices[0]?.slug as string | undefined) || null
  const tdBaseCosts = (partnerRow?.td_base_costs ?? {}) as Record<string, number>
  const tdBaseCost = primarySlug ? (Number(tdBaseCosts[primarySlug]) || null) : null

  // Same basis as the referrer rail: the REAL, cash-verified total across the whole plan — never
  // a single activation's amount, which for a plan deal is only PART of the commitment.
  const result = calculatePartnerPayout({
    model: offer.partner_payout_model as Parameters<typeof calculatePartnerPayout>[0]["model"],
    rate: offer.partner_payout_rate != null ? Number(offer.partner_payout_rate) : null,
    paymentAmount: settlement.totalAgreed,
    tdBaseCost,
  })

  const payoutStatus = result.error ? "manual_review" : "pending"
  const { error: insErr } = await supabaseAdmin
    .from("referral_payouts")
    // eslint-disable-next-line no-restricted-syntax -- offer_token/account_id/contact_id postdate generated types, same cast activate-service.ts already uses for this table
    .insert({
      partner_id: offer.partner_id,
      referral_id: null,
      payout_type: offer.partner_payout_model,
      amount: result.amount ?? 0,
      currency: "USD",
      payment_id: null,
      status: payoutStatus,
      notes: `Released — payment plan fully paid in full (${settlement.totalAgreed} ${settlement.currency} total). ${result.note || ""}`.trim(),
      offer_token: offerToken,
      account_id: offer.account_id,
      contact_id: offer.contact_id,
    } as never)

  if (insErr) return { attempted: true, ok: false, message: `Partner payout failed: ${insErr.message}` }
  if (result.error) {
    return { attempted: true, ok: true, message: `Partner payout needs manual review (${result.error}) — raised for approval.` }
  }
  return { attempted: true, ok: true, message: `Released $${result.amount} partner payout for approval.`, amount: result.amount ?? undefined }
}

export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await request.json().catch(() => ({}))
  const offerToken: string | undefined = typeof body?.offer_token === "string" ? body.offer_token : undefined
  if (!offerToken) return NextResponse.json({ error: "offer_token is required" }, { status: 400 })

  // Narrow-cast: same reason as plan-status/route.ts — the plan/referrer/partner columns
  // postdate the generated types.
  const offerQuery = supabaseAdmin
    .from("offers")
    .select("token, client_name, account_id, contact_id, services, referrer_name, referrer_contact_id, referrer_account_id, referrer_type, partner_id, partner_payout_model, partner_payout_rate" as never)
    .eq("token", offerToken)
    .maybeSingle() as unknown as { then: PromiseLike<{ data: OfferRow | null; error: { message: string } | null }>["then"] }
  const { data: offer, error: offerErr } = await offerQuery
  if (offerErr) return NextResponse.json({ error: offerErr.message }, { status: 500 })
  if (!offer) return NextResponse.json({ error: `No offer found for token "${offerToken}"` }, { status: 404 })

  const hasReferrer = Boolean(offer.referrer_name || offer.referrer_contact_id || offer.referrer_account_id)
  const hasPartner = Boolean(offer.partner_id && offer.partner_payout_model && offer.partner_payout_model !== "none")
  if (!hasReferrer && !hasPartner) {
    return NextResponse.json({ error: "This offer carries no referrer or managed partner — nothing to release." }, { status: 400 })
  }

  // ⛔ THE REAL GATE — computed fresh, right now, from the database. Never the GET route's cached
  // value, never anything the client sent.
  const settlement = await computePlanSettlement(offerToken)
  if (!settlement) {
    return NextResponse.json({ error: "This offer carries no valid payment plan." }, { status: 400 })
  }
  if (!settlement.eligible) {
    const open = settlement.parts.filter((p) => !p.settledInCash)
    return NextResponse.json({
      error: `Not fully paid in real cash yet — ${open.length} of ${settlement.parts.length} part(s) still outstanding. ` +
        "Release only opens once every part shows real money received, not just a credit-covered balance.",
      settlement,
    }, { status: 400 })
  }

  // Both rails run independently — one failing must not block the other, matching activation's
  // own try/catch-per-rail shape.
  const [referrerResult, partnerResult] = await Promise.all([
    releaseReferrerCredit(offer, offerToken, settlement),
    releasePartnerPayout(offer, offerToken, settlement),
  ])

  const messages = [referrerResult, partnerResult].filter((r) => r.attempted).map((r) => r.message)
  const anyFailed = [referrerResult, partnerResult].some((r) => r.attempted && !r.ok)
  const alreadyReleased = messages.length > 0 && messages.every((m) => m.includes("already released"))

  return NextResponse.json({
    ok: !anyFailed,
    already_released: alreadyReleased,
    message: messages.join(" "),
    referrer: referrerResult.attempted ? referrerResult : undefined,
    partner: partnerResult.attempted ? partnerResult : undefined,
    settlement: { totalAgreed: settlement.totalAgreed, totalReceived: settlement.totalReceived, currency: settlement.currency },
  }, { status: anyFailed ? 500 : 200 })
}
