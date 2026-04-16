/**
 * POST /api/crm/admin-actions/lead-delete-preview
 *
 * Admin-only. Returns a preview of everything that will be cascade-deleted
 * when a lead is deleted: offers, contracts, pending_activations, portal user.
 */

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { findAuthUserByEmail } from "@/lib/auth-admin-helpers"
import { canPerform } from "@/lib/permissions"

export async function POST(request: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!canPerform(user, "delete_record")) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 })
  }

  try {
    const { lead_id } = await request.json()

    if (!lead_id) {
      return NextResponse.json({ error: "Missing lead_id" }, { status: 400 })
    }

    // 1. Get the lead
    const { data: lead } = await supabaseAdmin
      .from("leads")
      .select("id, full_name, email, status")
      .eq("id", lead_id)
      .single()

    if (!lead) {
      return NextResponse.json({ error: "Lead not found" }, { status: 404 })
    }

    // 2. Get offers for this lead
    const { data: offers } = await supabaseAdmin
      .from("offers")
      .select("token, status, client_name")
      .eq("lead_id", lead_id)

    const offerTokens = (offers ?? []).map(o => o.token)

    // 3. Get contracts linked to those offers
    let contracts: Array<{ id: string; signed_at: string | null; offer_token: string }> = []
    if (offerTokens.length > 0) {
      const { data } = await supabaseAdmin
        .from("contracts")
        .select("id, signed_at, offer_token")
        .in("offer_token", offerTokens)
      contracts = data ?? []
    }

    // 4. Get pending_activations linked to those offers OR this lead
    let activations: Array<{ id: string; status: string; offer_token: string | null }> = []
    if (offerTokens.length > 0) {
      const { data } = await supabaseAdmin
        .from("pending_activations")
        .select("id, status, offer_token")
        .or(`lead_id.eq.${lead_id},offer_token.in.(${offerTokens.join(",")})`)
      activations = data ?? []
    } else {
      const { data } = await supabaseAdmin
        .from("pending_activations")
        .select("id, status, offer_token")
        .eq("lead_id", lead_id)
      activations = data ?? []
    }

    // 5. Check for portal user by email (paginated — P1.9)
    let portalUser: { id: string; email: string } | null = null
    if (lead.email) {
      const match = await findAuthUserByEmail(lead.email)
      if (match) {
        portalUser = { id: match.id, email: match.email ?? lead.email }
      }
    }

    return NextResponse.json({
      ok: true,
      lead: {
        id: lead.id,
        full_name: lead.full_name,
        email: lead.email,
        status: lead.status,
      },
      offers: (offers ?? []).map(o => ({ token: o.token, status: o.status })),
      contracts: contracts.map(c => ({
        id: c.id,
        signed_at: c.signed_at,
        offer_token: c.offer_token,
      })),
      activations: activations.map(a => ({
        id: a.id,
        status: a.status,
      })),
      portal_user: portalUser,
      summary: {
        offers: (offers ?? []).length,
        contracts: contracts.length,
        activations: activations.length,
        has_portal_user: !!portalUser,
      },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
