/**
 * Release a referrer's commission OR a managed partner's payout on a payment-plan deal — the
 * single human-confirmed action that replaces automatic per-part accrual (Antonio, 2026-08-13).
 *
 * POST /api/offers/release-commission
 *   body: { offer_token: string }
 *
 * ⛔ REWRITTEN 2026-08-14 after a code-level adversarial pass found the first version had two
 * real money bugs (bug-hunter, on the actual built/deployed commit — not the design, which had
 * already been through three review rounds before any of this was written):
 *
 * 1. A referrer AND a partner on the SAME offer were both paid. This codebase already has a
 *    rule against that — `shouldRunReferralCredit` (lib/partners/partner-deal.ts) — activation
 *    has ALWAYS skipped the generic referral credit when an offer also carries a managed
 *    partner, specifically "so the partner isn't paid twice." The first version of this route
 *    computed `hasReferrer`/`hasPartner` as two independent booleans and ran both unconditionally
 *    — directly contradicting that existing rule on the one path built today. Fixed by reusing
 *    `shouldRunReferralCredit` itself rather than re-deriving the condition a second time.
 *
 * 2. Two near-simultaneous release requests (a slow request + an impatient page reload, or two
 *    staff members open the same account) could both pass the "does a row already exist" check
 *    and both write a real payment. Neither `referrals` nor `referral_payouts` carries a
 *    database constraint backing that check — only a primary key. Fixed with a single atomic
 *    claim on the offer itself (`offers.commission_released_at`, migration
 *    `20260814-0100-offers-commission-released-at.sql`): a conditional UPDATE that only one
 *    concurrent request can ever win, attempted BEFORE either rail runs. Every other request —
 *    concurrent or later — sees the claim already taken and refuses cleanly, without touching
 *    money. This is the same shape as this codebase's established `reviewed_at IS NULL` + `.is()`
 *    guard pattern, applied to a new column instead of retrofitting uniqueness onto two tables
 *    shared by many other flows.
 *
 * A third, non-blocking gap was also closed: the route used to hardcode a generic 10%
 * credit-note commission regardless of what was actually agreed on the offer (a referrer
 * negotiated at a different rate, or a price-difference arrangement, would have been silently
 * miscalculated or refused). It now reads the offer's real commission terms.
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
import { shouldRunReferralCredit } from "@/lib/partners/partner-deal"

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
  referrer_commission_type: string | null
  referrer_commission_pct: number | string | null
  referrer_agreed_price: number | string | null
  partner_id: string | null
  partner_payout_model: string | null
  partner_payout_rate: number | string | null
}

async function releaseReferrerCredit(
  offer: OfferRow,
  offerToken: string,
  settlement: PlanSettlement,
): Promise<{ attempted: boolean; ok: boolean; message: string; amount?: number }> {
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

  // ⛔ THE OFFER'S REAL COMMISSION TERMS — not hardcoded nulls. Fixed 2026-08-14: the first
  // version passed null for type/pct/agreed_price unconditionally, so a referrer negotiated at
  // anything other than the generic 10% credit-note default was silently miscalculated, and a
  // price-difference arrangement (agreed_price genuinely null-safe only when actually 0) failed
  // outright. Commission basis is still the REAL total actually billed and cash-verified across
  // every part — grounded in the same rows `settlement.eligible` was just proven true against,
  // not a separately re-derived offer gross.
  const commission = resolveOfferCommission(
    {
      referrer_commission_type: offer.referrer_commission_type,
      referrer_type: offer.referrer_type,
      referrer_commission_pct: offer.referrer_commission_pct != null ? Number(offer.referrer_commission_pct) : null,
      referrer_agreed_price: offer.referrer_agreed_price != null ? Number(offer.referrer_agreed_price) : null,
    },
    settlement.totalAgreed,
  )
  if (!(commission.commissionAmount > 0)) {
    return {
      attempted: true,
      ok: false,
      message: `Referrer commission computed as ${commission.commissionAmount} — nothing to release. ` +
        "Check the referrer's commission terms on the offer.",
    }
  }
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
    .select("token, client_name, account_id, contact_id, services, referrer_name, referrer_contact_id, referrer_account_id, referrer_type, referrer_commission_type, referrer_commission_pct, referrer_agreed_price, partner_id, partner_payout_model, partner_payout_rate" as never)
    .eq("token", offerToken)
    .maybeSingle() as unknown as { then: PromiseLike<{ data: OfferRow | null; error: { message: string } | null }>["then"] }
  const { data: offer, error: offerErr } = await offerQuery
  if (offerErr) return NextResponse.json({ error: offerErr.message }, { status: 500 })
  if (!offer) return NextResponse.json({ error: `No offer found for token "${offerToken}"` }, { status: 404 })

  const hasPartner = Boolean(offer.partner_id && offer.partner_payout_model && offer.partner_payout_model !== "none")
  // ⛔ MUTUAL EXCLUSION — reuse the EXISTING rule, do not re-derive it. `shouldRunReferralCredit`
  // is exactly the function activation itself has always used to decide this; an offer with both
  // a referrer and a partner is compensated through the partner rail ONLY, "so the partner isn't
  // paid twice" (its own words). Computing this independently, as the first version of this route
  // did, is precisely how it paid both.
  const runReferrer = shouldRunReferralCredit(offer)
  if (!runReferrer && !hasPartner) {
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

  // ⛔ THE ATOMIC CLAIM (2026-08-14) — this is the actual fix for the double-release race, and it
  // runs BEFORE either rail. Only the request whose UPDATE actually flips a row from null wins
  // the right to proceed; every other concurrent or later call sees zero rows affected and
  // refuses cleanly, having touched no money. A plain SELECT-then-write (what shipped first) is
  // not atomic — two requests can both see "nothing yet" microseconds apart. A single conditional
  // UPDATE is: Postgres serializes concurrent writers to the same row, so exactly one succeeds.
  const { data: claimed, error: claimErr } = await supabaseAdmin
    .from("offers")
    // eslint-disable-next-line no-restricted-syntax -- commission_released_at postdates generated types (migration 20260814-0100)
    .update({ commission_released_at: new Date().toISOString() } as never)
    .eq("token", offerToken)
    .is("commission_released_at" as never, null)
    .select("token")
  if (claimErr) return NextResponse.json({ error: `Could not claim release: ${claimErr.message}` }, { status: 500 })
  if (!claimed || claimed.length === 0) {
    return NextResponse.json({ ok: true, already_released: true, message: "Already released — no second credit or payout was issued." })
  }

  // Only ONE of these ever runs for a given offer, per the mutual-exclusion rule above — never
  // both, and Promise.all here is just running the (at most one attempted) referrer path and the
  // (at most one attempted) partner path concurrently; it does not mean both fire.
  const [referrerResult, partnerResult] = await Promise.all([
    runReferrer
      ? releaseReferrerCredit(offer, offerToken, settlement)
      : Promise.resolve({ attempted: false, ok: true, message: "" }),
    hasPartner
      ? releasePartnerPayout(offer, offerToken, settlement)
      : Promise.resolve({ attempted: false, ok: true, message: "" }),
  ])

  const messages = [referrerResult, partnerResult].filter((r) => r.attempted).map((r) => r.message)
  const anyFailed = [referrerResult, partnerResult].some((r) => r.attempted && !r.ok)

  // If the attempted rail failed outright, release the claim so a retry (after staff fix
  // whatever was wrong — e.g. the free-text referrer) is not permanently locked out.
  if (anyFailed) {
    await supabaseAdmin
      .from("offers")
      // eslint-disable-next-line no-restricted-syntax -- same column as the claim above
      .update({ commission_released_at: null } as never)
      .eq("token", offerToken)
  }

  return NextResponse.json({
    ok: !anyFailed,
    already_released: false,
    message: messages.join(" "),
    referrer: referrerResult.attempted ? referrerResult : undefined,
    partner: partnerResult.attempted ? partnerResult : undefined,
    settlement: { totalAgreed: settlement.totalAgreed, totalReceived: settlement.totalReceived, currency: settlement.currency },
  }, { status: anyFailed ? 500 : 200 })
}
