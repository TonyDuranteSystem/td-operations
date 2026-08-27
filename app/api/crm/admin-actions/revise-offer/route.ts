/**
 * POST /api/crm/admin-actions/revise-offer
 *
 * Creates a new draft offer (v2+) from an existing published offer.
 * The original offer is marked 'superseded' with a pointer to the new version.
 * The original is PRESERVED — never deleted or modified beyond status + superseded_by.
 *
 * This is NOT resend (same version, same offer).
 * This is revise: new version, old one superseded, history preserved.
 *
 * Guards:
 * - Cannot revise a draft (edit it directly instead)
 * - Cannot revise a signed/completed offer (history must be preserved)
 * - Cannot revise an already superseded offer (revise the latest version)
 */

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { canPerform } from "@/lib/permissions"
import { logAction } from "@/lib/mcp/action-log"
import { getBankDetailsByPreference, type BankPreference } from "@/app/offer/[token]/contract/bank-defaults"
import { buildRevisedOfferInsert } from "@/lib/offers/revise-copy"
import type { Json } from "@/lib/database.types"

export async function POST(request: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!canPerform(user, "add_note")) {
    return NextResponse.json({ error: "Access required" }, { status: 403 })
  }

  try {
    const { offer_token } = await request.json()

    if (!offer_token) {
      return NextResponse.json({ error: "Missing offer_token" }, { status: 400 })
    }

    // Fetch the original offer
    const { data: original, error: fetchErr } = await supabaseAdmin
      .from("offers")
      .select("*")
      .eq("token", offer_token)
      .single()

    if (fetchErr || !original) {
      return NextResponse.json({ error: "Offer not found" }, { status: 404 })
    }

    // Status guards
    if (original.status === "draft") {
      return NextResponse.json(
        { error: "Cannot revise a draft — edit it directly instead." },
        { status: 400 }
      )
    }

    if (original.status === "signed" || original.status === "completed") {
      return NextResponse.json(
        { error: "Cannot revise a signed/completed offer — history must be preserved." },
        { status: 400 }
      )
    }

    if (original.status === "superseded") {
      return NextResponse.json(
        { error: "This offer is already superseded — revise the latest version instead." },
        { status: 400 }
      )
    }

    const newVersion = (original.version || 1) + 1
    const newToken = `${offer_token}-v${newVersion}`

    // Check for token collision
    const { data: tokenCheck } = await supabaseAdmin
      .from("offers")
      .select("token")
      .eq("token", newToken)
      .maybeSingle()

    const finalToken = tokenCheck
      ? `${newToken}-${Date.now().toString(36).slice(-4)}`
      : newToken

    // Resolve bank details for the new draft
    const currency = original.currency || "EUR"
    const bankPref = (original.bank_details as Record<string, unknown>)?.bank_preference as string || "auto"
    const bankDetails = getBankDetailsByPreference(
      bankPref as BankPreference,
      currency
    )

    // Create new draft as copy of original. The copy DECISION (what carries to
    // v2 vs what is deliberately dropped) lives in the pure, unit-tested
    // buildRevisedOfferInsert — lib/offers/revise-copy.ts. When adding a NEW
    // offers column, decide its fate THERE in the same change or it silently
    // vanishes on revision (WS-B triage, dev job c0a61e44).
    const insertPayload = buildRevisedOfferInsert(original as unknown as Record<string, unknown>, {
      finalToken,
      newVersion,
      offerDate: new Date().toISOString().split("T")[0],
      bankDetails: bankDetails as unknown as Json,
    })
    const { error: insertErr } = await supabaseAdmin
      .from("offers")
      .insert(insertPayload as never)
      .select("token, access_code, status, version")
      .single()

    if (insertErr) {
      return NextResponse.json({ error: insertErr.message }, { status: 500 })
    }

    // Mark original as superseded (only changes status + superseded_by — nothing
    // else) — conditioned on the row STILL matching what we read it as
    // (found by a second adversarial pass): the v2 draft above was already
    // built from that same read, so if a client's pick or signature landed
    // on the original in between, v2 is stale and superseding v1 underneath
    // it would bury the client's real, just-committed choice with no error
    // to anyone. Tying this write to both fields that read could have
    // changed catches either race; on a miss, the stale v2 is deleted and
    // staff is told to retry rather than silently shipping wrong data.
    const originalPackageLockedAt = (original as { package_locked_at?: string | null }).package_locked_at ?? null
    let supersedeQuery = supabaseAdmin
      .from("offers")
      .update({
        status: "superseded",
        superseded_by: finalToken,
      })
      .eq("token", offer_token)
      .eq("status", original.status)
    supersedeQuery = originalPackageLockedAt === null
      ? supersedeQuery.is("package_locked_at" as never, null)
      : supersedeQuery.eq("package_locked_at" as never, originalPackageLockedAt as never)
    const { data: superseded, error: supersedeErr } = await supersedeQuery.select("token")

    // ⛔ A real DB error here (e.g. a constraint violation) must NEVER be reported as
    // the race-condition message below — that exact conflation is what hid a live bug
    // for months: the offers_status_check constraint didn't allow 'superseded' until
    // 2026-08-27 (migration 20260827-2000), so this UPDATE failed on EVERY revision,
    // and every failure was misreported to staff as "the client just signed" when no
    // client had touched anything. Confirmed on production: christian-benavente-2026
    // is the one offer ever revised, and its v1 is still stuck un-superseded from
    // this exact failure. Surface the real error (R099) instead of guessing why.
    if (supersedeErr) {
      await supabaseAdmin.from("offers").delete().eq("token", finalToken)
      return NextResponse.json(
        { error: `Could not mark the original offer as superseded: ${supersedeErr.message}` },
        { status: 500 },
      )
    }

    if (!superseded || superseded.length === 0) {
      await supabaseAdmin.from("offers").delete().eq("token", finalToken)
      return NextResponse.json(
        {
          error: "This offer changed right as the revision was being created (the client likely just picked an option or signed). Nothing was changed — please try Revise again.",
        },
        { status: 409 },
      )
    }

    // Update lead to point to new offer
    if (original.lead_id) {
      await supabaseAdmin
        .from("leads")
        .update({
          offer_status: "Draft",
          updated_at: new Date().toISOString(),
        })
        .eq("id", original.lead_id)
    }

    logAction({
      actor: "crm-admin",
      action_type: "create",
      table_name: "offers",
      record_id: finalToken,
      summary: `Revised offer "${offer_token}" → v${newVersion} "${finalToken}"`,
      details: {
        original_token: offer_token,
        new_token: finalToken,
        version: newVersion,
        admin_email: user?.email,
      },
    })

    return NextResponse.json({
      success: true,
      token: finalToken,
      version: newVersion,
      original_token: offer_token,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error("[revise-offer] Error:", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
