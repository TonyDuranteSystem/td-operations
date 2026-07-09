/**
 * P3.4 #6 — thin delegation to lib/operations/offers.ts createOffer().
 * Same shared function as the MCP offer_create tool; drift between CRM
 * and Claude paths is now eliminated.
 */

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { canPerform } from "@/lib/permissions"
import { createOffer, type CreateOfferParams } from "@/lib/operations/offers"
import { reportSystemError } from "@/lib/system-errors"

export async function POST(req: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!canPerform(user, "create_offer")) {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 })
    }

    const body = await req.json()

    const params: CreateOfferParams = {
      client_name: body.client_name,
      client_email: body.client_email ?? null,
      language: (body.language as "en" | "it") || "en",
      lead_id: body.lead_id ?? null,
      account_id: body.account_id ?? null,
      contact_id: body.contact_id ?? null,
      contract_type: body.contract_type,
      entity_type: body.entity_type ?? null,
      payment_type: body.payment_type || "bank_transfer",
      payment_gateway: body.payment_gateway,
      bank_preference: body.bank_preference,
      currency: body.currency ? (String(body.currency).toUpperCase() as "EUR" | "USD") : undefined,
      services: body.services,
      cost_summary: body.cost_summary,
      recurring_costs: body.recurring_costs,
      bundled_pipelines: body.bundled_pipelines,
      required_documents: body.required_documents,
      issues: body.issues,
      admin_notes: body.admin_notes,
      installment_currency: body.installment_currency,
      intro_en: body.intro_en,
      intro_it: body.intro_it,
      strategy: body.strategy,
      next_steps: body.next_steps,
      future_developments: body.future_developments,
      immediate_actions: body.immediate_actions,
      referrer_name: body.referrer_name,
      referrer_type: body.referrer_type,
      referrer_contact_id: body.referrer_contact_id ?? null,
      referrer_account_id: body.referrer_account_id ?? null,
      // Managed-partner deal (per-sale): a partner sells at a custom price with a
      // setup share (paid at activation) + a renewal share (paid each year).
      partner_id: body.partner_id ?? null,
      partner_invoice_target: body.partner_invoice_target ?? null,
      partner_payout_model: body.partner_payout_model ?? null,
      partner_payout_rate: body.partner_payout_rate ?? null,
      partner_renewal_payout: body.partner_renewal_payout ?? null,
      source: "crm-button",
    }

    const result = await createOffer(params)

    if (result.outcome === "validation_error") {
      return NextResponse.json({ error: result.error }, { status: 400 })
    }
    if (result.outcome === "not_found") {
      return NextResponse.json({ error: result.error }, { status: 404 })
    }
    if (result.outcome === "duplicate_blocked") {
      return NextResponse.json(
        { error: result.error, existing_token: result.duplicate?.token },
        { status: 409 }
      )
    }
    if (!result.success) {
      return NextResponse.json({ error: result.error || "Internal error" }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      token: result.token,
      offer_url: result.offer_url,
      whop_checkout_url: result.whop_checkout_url,
    })
  } catch (err) {
    console.error("Create offer error:", err)
    await reportSystemError({
      source: "server",
      route: "/api/crm/admin-actions/create-offer",
      method: "POST",
      http_status: 500,
      message: err instanceof Error ? err.message : "Internal server error",
    })
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    )
  }
}
