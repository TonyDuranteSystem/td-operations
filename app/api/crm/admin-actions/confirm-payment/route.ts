/**
 * POST /api/crm/admin-actions/confirm-payment
 *
 * Admin-only endpoint to confirm a lead's payment and trigger the activation chain.
 * Two modes:
 *   1. With offer — pre-filled from offer data (90% of cases)
 *   2. Without offer — admin fills everything manually (legacy/exceptions)
 *
 * This endpoint:
 *   a. Creates/updates pending_activation with pessimistic lock
 *   b. Records payment in payments table
 *   c. Calls POST /api/workflows/activate-service (SAME chain as Whop webhook)
 *   d. Updates lead status to Converted
 *   e. Logs everything to action_log
 */

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { canPerform } from "@/lib/permissions"
import { logAction } from "@/lib/mcp/action-log"
import { findTaxReturnService } from "@/lib/tax-return-context"
import { INTERNAL_BASE_URL } from "@/lib/config"

interface ConfirmPaymentBody {
  lead_id: string
  // Payment info
  payment_method: string // "wire" | "card" | "crypto" | "cash" | "whop" | "other"
  payment_date: string   // YYYY-MM-DD
  payment_reference?: string
  paid_by_name?: string  // Third-party payer name (if different from lead)
  // Offer-derived (Mode 1) or manual (Mode 2)
  amount: number
  currency: "USD" | "EUR"
  contract_type: "formation" | "onboarding" | "tax_return" | "itin"
  bundled_pipelines: string[]
  // Optional manual overrides (Mode 2 only)
  annual_1st_installment?: number
  annual_2nd_installment?: number
  reason?: string
}

export async function POST(request: Request) {
  // Auth check — admin only
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!canPerform(user, "confirm_payment")) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 })
  }

  try {
    const body: ConfirmPaymentBody = await request.json()
    const {
      lead_id,
      payment_method,
      payment_date,
      payment_reference,
      paid_by_name,
      amount,
      currency,
      contract_type,
      bundled_pipelines,
      reason,
    } = body

    if (!lead_id || !amount || !currency || !contract_type) {
      return NextResponse.json(
        { error: "Missing required fields: lead_id, amount, currency, contract_type" },
        { status: 400 }
      )
    }

    // 1. Get lead
    const { data: lead, error: leadErr } = await supabaseAdmin
      .from("leads")
      .select("*")
      .eq("id", lead_id)
      .single()

    if (leadErr || !lead) {
      return NextResponse.json({ error: "Lead not found" }, { status: 404 })
    }

    // d715e5e5: no "already Converted" pre-gate. offer-signed no longer flips
    // lead.status to "Converted" on sign, so the only authoritative "already
    // done" signal is pending_activations.status === "activated", handled at
    // step 3 below (line ~143).

    // 2. Get offer (may not exist for legacy leads)
    const { data: offer } = await supabaseAdmin
      .from("offers")
      .select("token, status, contract_type, bundled_pipelines, cost_summary, client_email, client_name, services")
      .eq("lead_id", lead_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    // 2b. Preflight: Tax Return requires explicit service_context
    if (contract_type === "tax_return") {
      if (!offer) {
        return NextResponse.json(
          { error: "Tax Return payment requires an offer with explicit Business or Individual classification. Create an offer first, then confirm payment." },
          { status: 400 },
        )
      }
      const trResult = findTaxReturnService(
        Array.isArray(offer.services) ? offer.services as Array<Record<string, unknown>> : null
      )
      if (trResult.status === "not_found") {
        return NextResponse.json(
          { error: "This Tax Return offer has no Tax Return service entry. Update the offer before confirming payment." },
          { status: 400 },
        )
      }
      if (trResult.status === "multiple_matches") {
        return NextResponse.json(
          { error: `This offer has ${trResult.count} Tax Return service entries. Update the offer to have exactly one Tax Return service before confirming payment.` },
          { status: 400 },
        )
      }
      if (trResult.service_context !== "business" && trResult.service_context !== "individual") {
        return NextResponse.json(
          { error: "This Tax Return offer requires an explicit Business or Individual classification before payment can be confirmed. Update the offer's service context first." },
          { status: 400 },
        )
      }
    }

    // 3. Handle pending_activation with pessimistic lock
    let activationId: string | null = null

    // Check if pending_activation exists for this lead.
    // portal_invoice_id is read so the raw payments insert below can be skipped
    // when offer-signed already created a draft invoice (activate-service flips
    // it to Paid; inserting again creates a duplicate).
    const { data: existingActivation } = await supabaseAdmin
      .from("pending_activations")
      .select("id, status, portal_invoice_id")
      .eq("lead_id", lead_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    if (existingActivation) {
      if (existingActivation.status === "activated") {
        return NextResponse.json(
          { error: "This lead already has an activated service. Check the contact/account." },
          { status: 409 }
        )
      }

      // Pessimistic lock: try to claim it
      const { data: locked, error: lockErr } = await supabaseAdmin
        .from("pending_activations")
        .update({
          status: "payment_confirmed",
          amount,
          currency,
          payment_method: payment_method || "wire",
          payment_confirmed_at: new Date().toISOString(),
          notes: [
            `Admin confirmed. Method: ${payment_method}. Ref: ${payment_reference || "N/A"}.`,
            paid_by_name ? `Paid by: ${paid_by_name}.` : null,
            reason ? `Reason: ${reason}` : null,
          ].filter(Boolean).join(" "),
          updated_at: new Date().toISOString(),
        })
        .eq("id", existingActivation.id)
        .in("status", ["awaiting_payment", "pending_confirmation"])
        .select("id")
        .single()

      if (lockErr || !locked) {
        return NextResponse.json(
          { error: "This activation is already being processed by another session." },
          { status: 409 }
        )
      }
      activationId = locked.id
    } else {
      // No pending_activation exists (legacy lead, no offer signed)
      // Create one from admin dialog data
      const { data: newActivation, error: createErr } = await supabaseAdmin
        .from("pending_activations")
        .insert({
          offer_token: offer?.token || `admin-${lead_id.slice(0, 8)}`,
          lead_id,
          client_name: lead.full_name,
          client_email: lead.email,
          amount,
          currency,
          payment_method: payment_method || "wire",
          status: "payment_confirmed",
          payment_confirmed_at: new Date().toISOString(),
          notes: [
            `Admin created + confirmed. Method: ${payment_method}. Ref: ${payment_reference || "N/A"}.`,
            paid_by_name ? `Paid by: ${paid_by_name}.` : null,
            reason ? `Reason: ${reason}` : null,
          ].filter(Boolean).join(" "),
        })
        .select("id")
        .single()

      if (createErr || !newActivation) {
        return NextResponse.json(
          { error: `Failed to create activation: ${createErr?.message}` },
          { status: 500 }
        )
      }
      activationId = newActivation.id
    }

    // 4. Update offer bundled_pipelines if needed (for Mode 2 — no offer or missing pipelines)
    if (offer?.token && bundled_pipelines?.length > 0) {
      const existingPipelines = Array.isArray(offer.bundled_pipelines) ? offer.bundled_pipelines : []
      if (existingPipelines.length === 0) {
        await supabaseAdmin
          .from("offers")
          .update({
            bundled_pipelines,
            contract_type,
            updated_at: new Date().toISOString(),
          })
          .eq("token", offer.token)
      }
    } else if (!offer && bundled_pipelines?.length > 0) {
      // Create a minimal offer record for legacy leads so activate-service can read it
      await supabaseAdmin
        .from("offers")
        .insert({
          token: `admin-${lead_id.slice(0, 8)}-${Date.now()}`,
          lead_id,
          client_name: lead.full_name,
          client_email: lead.email,
          language: lead.language === "Italian" ? "it" : "en",
          contract_type,
          bundled_pipelines,
          payment_type: "bank_transfer",
          status: "completed",
          services: [],
          cost_summary: [{ label: "Admin-confirmed payment", total: `${currency} ${amount}` }],
        })

      // Update the activation to reference this new offer
      await supabaseAdmin
        .from("pending_activations")
        .update({ offer_token: `admin-${lead_id.slice(0, 8)}-${Date.now()}` })
        .eq("id", activationId)
    }

    // 5. Create payment record
    // Find contact + account if either already exists for this lead
    let accountId: string | null = null
    let contactId: string | null = null
    if (lead.email) {
      const { data: contact } = await supabaseAdmin
        .from("contacts")
        .select("id")
        .ilike("email", lead.email)
        .limit(1)
        .maybeSingle()

      if (contact) {
        contactId = contact.id
        const { data: ac } = await supabaseAdmin
          .from("account_contacts")
          .select("account_id")
          .eq("contact_id", contact.id)
          .limit(1)
          .maybeSingle()
        accountId = ac?.account_id || null
      }
    }

    // Skip when an existing draft invoice is already linked to the activation
    // (offer-signed created it). activate-service flips that draft to Paid via
    // syncInvoiceStatus('payment', ...) — the canonical path. Doing anything
    // here would create a duplicate Paid row.
    //
    // For Mode 2 (legacy lead, no offer, no draft) we route through
    // createTDInvoice — the same canonical helper used by offer-signed and
    // every other invoice creation path. This produces a proper invoice with
    // an invoice_number, the client_expenses mirror, and an idempotency_key
    // tied to (lead_id + payment_date + amount) so retrying the button does
    // not double-charge or double-record.
    if (!existingActivation?.portal_invoice_id) {
      try {
        const { createTDInvoice } = await import("@/lib/portal/td-invoice")
        const paidDate = payment_date || new Date().toISOString().split("T")[0]
        const noteParts = [
          payment_reference ? `Ref: ${payment_reference}` : null,
          paid_by_name ? `Paid by: ${paid_by_name}` : null,
          `Admin-confirmed payment for legacy lead.`,
        ].filter(Boolean)
        await createTDInvoice({
          account_id: accountId || undefined,
          contact_id: contactId || undefined,
          line_items: [{
            description: `${contract_type} - ${lead.full_name} (admin confirmed)`,
            unit_price: amount,
            quantity: 1,
          }],
          currency,
          mark_as_paid: true,
          paid_date: paidDate,
          payment_method: payment_method || "wire",
          notes: noteParts.join(". "),
          idempotency_key: `manual-confirm-payment:${lead_id}:${paidDate}:${amount}`,
        })
      } catch (invErr) {
        console.error("[confirm-payment] createTDInvoice failed:", invErr)
        logAction({
          actor: "crm-admin",
          action_type: "error",
          table_name: "payments",
          summary: `Invoice creation failed for ${lead.full_name}: ${invErr instanceof Error ? invErr.message : String(invErr)}`,
          details: { lead_id, error: invErr instanceof Error ? invErr.message : String(invErr) },
        })
      }
    }

    // 6. Update lead status
    await supabaseAdmin
      .from("leads")
      .update({
        status: "Converted",
        updated_at: new Date().toISOString(),
      })
      .eq("id", lead_id)

    // 7. Call activate-service (SAME chain as Whop webhook)
    let activationResult = null
    try {
      const baseUrl = process.env.NEXT_PUBLIC_APP_URL || INTERNAL_BASE_URL

      const res = await fetch(`${baseUrl}/api/workflows/activate-service`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.API_SECRET_TOKEN}`,
        },
        body: JSON.stringify({ pending_activation_id: activationId }),
      })

      activationResult = await res.json()
    } catch (err) {
      console.error("[confirm-payment] activate-service call failed:", err)
      activationResult = { error: err instanceof Error ? err.message : String(err) }
    }

    // 7b. Bank-feed linker (PR 1 Step 7) — wire-only, single-match.
    // After activate-service runs successfully and the invoice is marked Paid,
    // try to attach the unmatched bank feed row to that invoice. Avoids the
    // manual "go to bank-feed UI and click Match" step for the common case.
    //
    // Conservative rules: only fire for wire payments, only link when exactly
    // one feed matches (amount within 5%, name fuzzy match on client_name's
    // first word, transaction_date within ±30 days of payment_date). Anything
    // ambiguous stays unmatched and is handled by the existing bank-feed UI.
    let feedLinkResult: { linked: boolean; feed_id?: string; reason?: string } | null = null
    const isWire = (payment_method || "").toLowerCase() === "wire" || (payment_method || "").toLowerCase() === "bank_transfer"
    const activationOkInline = activationResult && !activationResult.error
    if (isWire && activationOkInline && existingActivation?.portal_invoice_id) {
      try {
        const paymentDateStr = payment_date || new Date().toISOString().split("T")[0]
        const paymentDateObj = new Date(paymentDateStr)
        const fromDate = new Date(paymentDateObj.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0]
        const toDate = new Date(paymentDateObj.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0]
        const tolerance = amount * 0.05
        const minAmount = amount - tolerance
        const maxAmount = amount + tolerance
        const clientFirstWord = (lead.full_name || "").split(/\s+/)[0]?.toLowerCase() || ""

        const { data: candidates } = await supabaseAdmin
          .from("td_bank_feeds")
          .select("id, amount, sender_name, sender_reference, memo, transaction_date")
          .eq("status", "unmatched")
          .gte("transaction_date", fromDate)
          .lte("transaction_date", toDate)
          .gte("amount", minAmount)
          .lte("amount", maxAmount)

        const matches = (candidates || []).filter(c => {
          if (!clientFirstWord) return false
          const haystack = `${c.sender_name || ""} ${c.sender_reference || ""} ${c.memo || ""}`.toLowerCase()
          return haystack.includes(clientFirstWord)
        })

        if (matches.length === 1) {
          const feed = matches[0]
          await supabaseAdmin
            .from("td_bank_feeds")
            .update({
              status: "matched",
              matched_payment_id: existingActivation.portal_invoice_id,
              matched_by: "confirm_payment_auto",
              updated_at: new Date().toISOString(),
            })
            .eq("id", feed.id)
            .eq("status", "unmatched")
          feedLinkResult = { linked: true, feed_id: feed.id }
        } else if (matches.length === 0) {
          feedLinkResult = { linked: false, reason: "no candidate feed matched amount + name + date window" }
        } else {
          feedLinkResult = { linked: false, reason: `${matches.length} candidate feeds matched — manual review required` }
        }
      } catch (linkerErr) {
        console.error("[confirm-payment] bank-feed linker failed:", linkerErr)
        feedLinkResult = { linked: false, reason: linkerErr instanceof Error ? linkerErr.message : "unknown error" }
      }
    }

    // 8. Log to action_log
    logAction({
      actor: "crm-admin",
      action_type: "confirm_payment",
      table_name: "pending_activations",
      record_id: activationId || undefined,
      account_id: accountId || undefined,
      summary: `Payment confirmed by admin for ${lead.full_name}. ${currency} ${amount} via ${payment_method}. Ref: ${payment_reference || "N/A"}${paid_by_name ? `. Paid by: ${paid_by_name}` : ""}`,
      details: {
        lead_id,
        offer_token: offer?.token,
        activation_id: activationId,
        payment_method,
        payment_reference,
        paid_by_name: paid_by_name || null,
        amount,
        currency,
        contract_type,
        bundled_pipelines,
        reason,
        activation_result: activationResult,
        feed_link_result: feedLinkResult,
        admin_email: user?.email,
      },
    })

    const activationOk = activationResult && !activationResult.error
    return NextResponse.json({
      ok: true,
      message: activationOk
        ? `Payment confirmed for ${lead.full_name}. Activation chain triggered successfully.`
        : `Payment confirmed for ${lead.full_name}. Activation chain had issues — check action_log.`,
      activation_id: activationId,
      activation_result: activationResult,
      activation_ok: activationOk,
      feed_link_result: feedLinkResult,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error("[confirm-payment] Error:", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
