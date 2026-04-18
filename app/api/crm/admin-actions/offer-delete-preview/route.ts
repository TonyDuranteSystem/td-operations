/**
 * POST /api/crm/admin-actions/offer-delete-preview
 *
 * P3.7: dry-run companion for {@link ../delete-offer/route.ts}.
 * Returns a DryRunResult shape describing what the cascade delete will
 * remove (contracts, pending_activations) so the operator sees the full
 * impact before confirming.
 */

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { canPerform } from "@/lib/permissions"
import type { DryRunResult } from "@/lib/operations/destructive"

export async function POST(request: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!canPerform(user, "delete_record")) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 })
  }

  try {
    const { offer_token } = await request.json()

    if (!offer_token) {
      return NextResponse.json({ error: "Missing offer_token" }, { status: 400 })
    }

    const { data: offer } = await supabaseAdmin
      .from("offers")
      .select("token, lead_id, client_name, status")
      .eq("token", offer_token)
      .maybeSingle()

    if (!offer) {
      return NextResponse.json({ error: "Offer not found" }, { status: 404 })
    }

    const [{ data: contracts }, { data: activations }] = await Promise.all([
      supabaseAdmin
        .from("contracts")
        .select("id, signed_at")
        .eq("offer_token", offer_token),
      supabaseAdmin
        .from("pending_activations")
        .select("id, status")
        .eq("offer_token", offer_token),
    ])

    const signedCount = (contracts ?? []).filter(c => c.signed_at).length

    const preview: DryRunResult = {
      affected: {
        offer: 1,
        contracts: contracts?.length ?? 0,
        pending_activations: activations?.length ?? 0,
      },
      items: [
        {
          label: `Offer ${offer.token}`,
          details: [offer.client_name ?? "unknown", offer.status ?? "no status"],
        },
      ],
      warnings: [],
      record_label: offer.token,
    }

    if ((contracts?.length ?? 0) > 0) {
      preview.items.push({
        label: `${contracts!.length} contract${contracts!.length === 1 ? "" : "s"}`,
        details: contracts!.map(c => (c.signed_at ? `signed ${c.signed_at.split("T")[0]}` : "unsigned")),
      })
    }
    if ((activations?.length ?? 0) > 0) {
      preview.items.push({
        label: `${activations!.length} pending activation${activations!.length === 1 ? "" : "s"}`,
        details: activations!.map(a => a.status ?? "unknown"),
      })
    }
    if (offer.lead_id) {
      preview.items.push({ label: "Reset linked lead back to Call Done if currently Offer Sent / Negotiating" })
    }
    if (signedCount > 0) {
      preview.warnings!.push(
        `${signedCount} contract${signedCount === 1 ? " was" : "s were"} already signed — deletion loses the signed record.`,
      )
    }

    return NextResponse.json(preview)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
