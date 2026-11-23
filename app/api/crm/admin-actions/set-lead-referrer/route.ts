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
import { canPerform } from "@/lib/permissions"
import { logAction } from "@/lib/mcp/action-log"
import { setLeadReferrer } from "@/lib/operations/lead-referrer"

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

    // Persist + reconcile the pending referral + notify the referrer — one shared routine (also used when an
    // offer is created from a lead), so the lead page and the offer window can never disagree.
    const res = await setLeadReferrer(leadId, { referrerName, contactId, accountId })
    if (!res.ok) {
      return NextResponse.json({ error: res.error }, { status: res.reason === "lead_not_found" ? 404 : 500 })
    }
    const created = res.referralCreated
    const cancelled = res.referralCancelled
    const createSkip = res.referralSkip

    logAction({
      actor: "crm-admin",
      action_type: "update",
      table_name: "leads",
      record_id: leadId,
      summary: `Set referrer for lead "${res.leadName}"${referrerName ? ` → ${referrerName}` : " (cleared)"}`,
      details: { lead_id: leadId, referrer_name: referrerName, referrer_contact_id: contactId, referrer_account_id: accountId, referral_created: created, referral_cancelled: cancelled, referral_skip: createSkip, admin_email: user?.email },
    })

    return NextResponse.json({ ok: true, referral_created: created, referral_cancelled: cancelled, referral_skip: createSkip })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
