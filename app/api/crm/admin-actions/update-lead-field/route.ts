/**
 * POST /api/crm/admin-actions/update-lead-field
 *
 * Generic endpoint to update a single lead field.
 * Only allows whitelisted fields to prevent arbitrary writes.
 */

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { canPerform } from "@/lib/permissions"
import { logAction } from "@/lib/mcp/action-log"
import { syncLeadEmailToOfferArtifacts } from "@/lib/offers/sync-offer-email"
import { updateLeadColumnGuarded, hasExpectedValue, isGuardedFailure, type LeadDb } from "@/lib/leads/guarded-update"

const ALLOWED_FIELDS = [
  "full_name",
  "email",
  "phone",
  "language",
  "source",
  "referrer_name",
  "call_date",
  "call_notes",
  "status",
]

// R094: "Converted"/"Paid" mean payment confirmed — never a plain field edit.
// Dedicated flows (Convert to Contact, Confirm Payment, the payment webhooks)
// are the only paths allowed to set them; this generic endpoint must refuse.
const BLOCKED_STATUS_VALUES = ["Converted", "Paid"]

export async function POST(request: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!canPerform(user, "add_note")) {
    return NextResponse.json({ error: "Access required" }, { status: 403 })
  }

  try {
    const body = await request.json()
    const { lead_id, field, value } = body

    if (!lead_id || !field) {
      return NextResponse.json({ error: "Missing lead_id or field" }, { status: 400 })
    }

    if (!ALLOWED_FIELDS.includes(field)) {
      return NextResponse.json({ error: `Field '${field}' is not editable` }, { status: 400 })
    }

    // Validate specific fields
    if (field === "full_name" && (!value || !value.trim())) {
      return NextResponse.json({ error: "Name cannot be empty" }, { status: 400 })
    }

    if (field === "email" && value) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
      if (!emailRegex.test(value.trim())) {
        return NextResponse.json({ error: "Invalid email format" }, { status: 400 })
      }
    }

    if (field === "status" && BLOCKED_STATUS_VALUES.includes(value)) {
      return NextResponse.json(
        { error: `Status "${value}" cannot be set directly. Use Convert to Contact / Confirm Payment on the lead's Actions panel.` },
        { status: 400 }
      )
    }

    const { data: lead } = await supabaseAdmin
      .from("leads")
      .select("full_name, email")
      .eq("id", lead_id)
      .single()

    if (!lead) {
      return NextResponse.json({ error: "Lead not found" }, { status: 404 })
    }

    // Normalize value: empty string → null for nullable fields
    const normalizedValue = (value === "" || value === undefined) ? null : value.trim()

    // Guarded write (dev job f3f3e237 / d26b8a7e): refuse, instead of silently overwriting,
    // when THIS field changed since the caller opened it. `expected_value` is what the caller
    // was editing from; older callers that omit it still get the read-then-write race check.
    const guarded = await updateLeadColumnGuarded(supabaseAdmin as unknown as LeadDb, {
      leadId: lead_id,
      column: field,
      newValue: normalizedValue,
      expected: body.expected_value,
      hasExpected: hasExpectedValue(body, "expected_value"),
    })
    if (isGuardedFailure(guarded)) {
      if (guarded.reason === "conflict") {
        return NextResponse.json(
          { error: guarded.message, conflict: true, current_value: guarded.currentValue },
          { status: 409 }
        )
      }
      if (guarded.reason === "not_found") {
        return NextResponse.json({ error: guarded.message }, { status: 404 })
      }
      return NextResponse.json({ error: guarded.message }, { status: 500 })
    }

    // When the email is corrected, carry the fix across to the offer + portal
    // artifacts that were created from the old address, so a re-send reaches
    // the right inbox and does not spawn a duplicate portal account.
    let emailSync: Awaited<ReturnType<typeof syncLeadEmailToOfferArtifacts>> | undefined
    if (field === "email" && normalizedValue) {
      // The lead row is already updated; a propagation failure must not undo
      // that or 500 the request — it is best-effort and self-reports.
      try {
        emailSync = await syncLeadEmailToOfferArtifacts({
          leadId: lead_id,
          oldEmail: lead.email,
          newEmail: normalizedValue,
        })
      } catch (syncErr) {
        emailSync = {
          offersUpdated: 0,
          contactUpdated: false,
          authUserUpdated: false,
          skipped: [`sync failed: ${syncErr instanceof Error ? syncErr.message : String(syncErr)}`],
        }
      }
    }

    logAction({
      actor: "crm-admin",
      action_type: "update",
      table_name: "leads",
      record_id: lead_id,
      summary: `Updated ${field} for lead "${lead.full_name}"`,
      details: { lead_id, field, new_value: normalizedValue, admin_email: user?.email, email_sync: emailSync ?? null },
    })

    return NextResponse.json({ ok: true, email_sync: emailSync ?? null })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
