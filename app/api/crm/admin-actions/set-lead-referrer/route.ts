/**
 * POST /api/crm/admin-actions/set-lead-referrer
 *
 * Set / change / clear a lead's referrer from the Lead detail page.
 *
 * A referrer is a real client (contact) and/or their company (account) — pinned
 * by ID — or a free-text name only. Pinning a contact/account referrer also
 * creates the referrer<->lead PENDING referral immediately (so the referrer is
 * linked from the lead stage, before any conversion). When the referred lead
 * later pays, the existing lead-keyed credit path (activate-service Step 3.5b)
 * converts that pending referral and issues the referrer's reward.
 *
 * Re-assigning or clearing only ever cancels a still-PENDING link — a referral
 * that already converted/credited/paid is never touched.
 */

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { canPerform } from "@/lib/permissions"
import { logAction } from "@/lib/mcp/action-log"
import { createPendingReferral, reconcilePendingReferral, type PendingReferralRow } from "@/lib/operations/referral"

export async function POST(request: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!canPerform(user, "add_note")) {
    return NextResponse.json({ error: "Access required" }, { status: 403 })
  }

  try {
    const body = await request.json()
    const leadId: string | undefined = body.lead_id
    if (!leadId) {
      return NextResponse.json({ error: "Missing lead_id" }, { status: 400 })
    }

    const referrerName: string | null = typeof body.referrer_name === "string" && body.referrer_name.trim()
      ? body.referrer_name.trim()
      : null
    const contactId: string | null = typeof body.referrer_contact_id === "string" && body.referrer_contact_id
      ? body.referrer_contact_id
      : null
    const accountId: string | null = typeof body.referrer_account_id === "string" && body.referrer_account_id
      ? body.referrer_account_id
      : null

    const { data: lead } = await supabaseAdmin
      .from("leads")
      .select("full_name, email")
      .eq("id", leadId)
      .single()

    if (!lead) {
      return NextResponse.json({ error: "Lead not found" }, { status: 404 })
    }

    // 1. Persist the referrer fields on the lead.
    const { error: updErr } = await supabaseAdmin
      .from("leads")
      .update({
        referrer_name: referrerName,
        referrer_contact_id: contactId,
        referrer_account_id: accountId,
        updated_at: new Date().toISOString(),
      })
      .eq("id", leadId)

    if (updErr) {
      return NextResponse.json({ error: updErr.message }, { status: 500 })
    }

    // 2. Reconcile the lead's pending referral link. Only pending rows are touched.
    const { data: existingRaw } = await supabaseAdmin
      .from("referrals")
      .select("id, referrer_contact_id, referrer_account_id, status")
      .eq("referred_lead_id", leadId)

    const existing = (existingRaw ?? []) as PendingReferralRow[]
    const next = (contactId || accountId) ? { contactId, accountId } : null
    const { cancelIds, createFor, updateAccountId } = reconcilePendingReferral(existing, next)

    let cancelled = 0
    if (cancelIds.length > 0) {
      const { error: cancelErr } = await supabaseAdmin
        .from("referrals")
        .update({ status: "cancelled" })
        .in("id", cancelIds)
      if (!cancelErr) cancelled = cancelIds.length
    }

    // Keep the kept referral's credit target in sync when staff change the
    // "credit goes to" company for the same referrer.
    if (updateAccountId) {
      await supabaseAdmin
        .from("referrals")
        .update({ referrer_account_id: updateAccountId.accountId })
        .eq("id", updateAccountId.id)
    }

    let created: string | null = null
    let createSkip: string | null = null
    if (createFor) {
      const res = await createPendingReferral(
        {
          referrerContactId: createFor.contactId,
          referrerAccountId: createFor.accountId,
          referredLeadId: leadId,
          referredName: lead.full_name || referrerName || "Lead",
          referredEmail: lead.email || "",
        },
        supabaseAdmin,
      )
      if (res.created) {
        created = res.id
      } else if ('reason' in res) {
        createSkip = res.reason
      }
    }

    logAction({
      actor: "crm-admin",
      action_type: "update",
      table_name: "leads",
      record_id: leadId,
      summary: `Set referrer for lead "${lead.full_name}"${referrerName ? ` → ${referrerName}` : " (cleared)"}`,
      details: { lead_id: leadId, referrer_name: referrerName, referrer_contact_id: contactId, referrer_account_id: accountId, referral_created: created, referral_cancelled: cancelled, referral_skip: createSkip, admin_email: user?.email },
    })

    return NextResponse.json({ ok: true, referral_created: created, referral_cancelled: cancelled, referral_skip: createSkip })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
