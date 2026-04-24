import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isAdmin } from "@/lib/auth"
import { reconcileTier } from "@/lib/operations/portal"
import { TIER_ORDER, type PortalTier } from "@/lib/portal/tier-config"

/**
 * POST /api/crm/admin-actions/reconcile-portal-tier
 *
 * P3.4 #2 — Portal tier sync unified button (closes dev_task 6d2a2be1).
 *
 * Forces a contact's portal_tier, the portal_tier on all accounts linked to
 * that contact, and the auth user's app_metadata.portal_tier to all match.
 * Source of truth: contacts.portal_tier (or a provided target_tier override).
 *
 * Body: { contact_id: string, target_tier?: PortalTier, reason?: string }
 * Response: { success, resolved_tier, changed: { contact, accounts, auth_user } }
 *
 * Idempotent. Admin-only. Logged to action_log with the admin's identity.
 */
const VALID_TIERS: readonly PortalTier[] = TIER_ORDER

export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 })
  }

  const body = await request.json().catch(() => null) as {
    contact_id?: string
    target_tier?: string
    reason?: string
  } | null

  if (!body?.contact_id) {
    return NextResponse.json({ error: "contact_id required" }, { status: 400 })
  }

  if (body.target_tier && !VALID_TIERS.includes(body.target_tier as PortalTier)) {
    return NextResponse.json(
      { error: `Invalid target_tier. Must be one of: ${VALID_TIERS.join(", ")}` },
      { status: 400 },
    )
  }

  const { data: contactBefore } = await supabaseAdmin
    .from("contacts")
    .select("id, full_name, email, portal_tier")
    .eq("id", body.contact_id)
    .single()

  if (!contactBefore) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 })
  }

  const result = await reconcileTier({
    contact_id: body.contact_id,
    target_tier: body.target_tier as PortalTier | undefined,
  })

  if (!result.success) {
    return NextResponse.json({ error: result.error ?? "Reconcile failed" }, { status: 500 })
  }

  await supabaseAdmin.from("action_log").insert({
    actor: `dashboard:${user.email?.split("@")[0] ?? "unknown"}`,
    action_type: "update",
    table_name: "contacts",
    record_id: body.contact_id,
    summary: `Reconciled portal tier → ${result.resolved_tier}`,
    details: {
      contact_id: body.contact_id,
      contact_name: contactBefore.full_name,
      previous_contact_tier: contactBefore.portal_tier,
      resolved_tier: result.resolved_tier,
      target_tier_override: body.target_tier ?? null,
      changed: result.changed,
      reason: body.reason ?? null,
    },
  })

  const changedCount =
    (result.changed.contact ? 1 : 0) +
    result.changed.accounts.length +
    (result.changed.auth_user ? 1 : 0)

  return NextResponse.json({
    success: true,
    resolved_tier: result.resolved_tier,
    changed: result.changed,
    message:
      changedCount === 0
        ? `No drift — all layers already at "${result.resolved_tier}"`
        : `Reconciled to "${result.resolved_tier}". Updated: ${
            [
              result.changed.contact ? "contact" : null,
              result.changed.accounts.length > 0 ? `${result.changed.accounts.length} account(s)` : null,
              result.changed.auth_user ? "auth user" : null,
            ]
              .filter(Boolean)
              .join(", ")
          }.`,
  })
}
