/**
 * POST /api/crm/admin-actions/offer-reset-preview
 *
 * P3.7: dry-run companion for {@link ../reset-offer/route.ts}.
 * Returns a DryRunResult shape showing what a reset will clear (signed
 * contracts, pending activations, payment links) before the operator
 * confirms.
 */

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { canPerform } from "@/lib/permissions"
import type { DryRunResult } from "@/lib/operations/destructive"

export async function POST(request: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!canPerform(user, "create_offer")) {
    return NextResponse.json({ error: "Dashboard access required" }, { status: 403 })
  }

  try {
    const { offer_token } = await request.json()

    if (!offer_token) {
      return NextResponse.json({ error: "Missing offer_token" }, { status: 400 })
    }

    const { data: offer } = await supabaseAdmin
      .from("offers")
      .select("token, client_name, status, payment_links")
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
    const paymentLinks = offer.payment_links as Record<string, unknown> | null
    const hasPaymentLink = !!paymentLinks && Object.keys(paymentLinks).length > 0

    const preview: DryRunResult = {
      affected: {
        offer: 1,
        contracts: contracts?.length ?? 0,
        pending_activations: activations?.length ?? 0,
        payment_link: hasPaymentLink ? 1 : 0,
      },
      items: [
        {
          label: `Reset offer ${offer.token} to draft`,
          details: [offer.client_name ?? "unknown", offer.status ?? "no status"],
        },
      ],
      warnings: [],
      record_label: offer.token,
    }

    if ((contracts?.length ?? 0) > 0) {
      preview.items.push({
        label: `Delete ${contracts!.length} contract${contracts!.length === 1 ? "" : "s"}`,
        details: contracts!.map(c => (c.signed_at ? `signed ${c.signed_at.split("T")[0]}` : "unsigned")),
      })
    }
    if ((activations?.length ?? 0) > 0) {
      preview.items.push({
        label: `Delete ${activations!.length} pending activation${activations!.length === 1 ? "" : "s"}`,
      })
    }
    if (hasPaymentLink) {
      preview.items.push({ label: "Clear payment link" })
    }
    if (signedCount > 0) {
      preview.warnings!.push(
        `${signedCount} contract${signedCount === 1 ? " was" : "s were"} already signed — the signature is lost.`,
      )
    }

    return NextResponse.json(preview)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
