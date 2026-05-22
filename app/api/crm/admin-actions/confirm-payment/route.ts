/**
 * POST /api/crm/admin-actions/confirm-payment
 *
 * Admin-only endpoint to confirm a payment and trigger the activation chain.
 *
 * Identifier — caller provides ONE of (priority order, most specific first):
 *   - offer_token  — directly identifies the offer; resolves account_id,
 *                    lead_id, contact, and client info from it.
 *   - lead_id      — classic lead funnel (lead → offer → sign → pay).
 *   - account_id   — existing-client re-entry (e.g. One-Time customer buying
 *                    annual MSA). Picks the most recent non-expired offer on
 *                    that account.
 *   - contact_id   — existing-contact re-entry (contact has no current account
 *                    or no current lead — buyer is a known person). Resolves
 *                    via offers.client_email = contacts.email.
 *
 * Modes:
 *   1. With offer (the normal case) — pre-filled from offer data.
 *   2. Without offer — admin fills bundled_pipelines manually. Only valid
 *      for the lead_id path; rejected for account/contact/offer_token paths.
 *
 * This endpoint:
 *   a. Creates/updates pending_activation with pessimistic lock
 *   b. Records payment via createTDInvoice (idempotent on retry)
 *   c. Calls POST /api/workflows/activate-service (same chain as Whop/Stripe webhooks)
 *   d. Updates lead status to Converted (only if a lead exists)
 *   e. Logs everything to action_log
 */

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { canPerform } from "@/lib/permissions"
import { logAction } from "@/lib/mcp/action-log"
import { findTaxReturnService } from "@/lib/tax-return-context"
import { runActivation } from "@/lib/operations/activate-service"

interface ConfirmPaymentBody {
  // Identifier — exactly one required
  lead_id?: string
  account_id?: string
  contact_id?: string
  offer_token?: string
  // Payment info
  payment_method: string // "wire" | "card" | "crypto" | "cash" | "whop" | "other"
  payment_date: string   // YYYY-MM-DD
  payment_reference?: string
  paid_by_name?: string  // Third-party payer name (if different from buyer)
  // Offer-derived (Mode 1) or manual (Mode 2 — lead_id only)
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
      account_id,
      contact_id,
      offer_token,
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

    if (!lead_id && !account_id && !contact_id && !offer_token) {
      return NextResponse.json(
        { error: "Provide one of: lead_id, account_id, contact_id, offer_token" },
        { status: 400 }
      )
    }
    // amount === 0 is valid (free / already-settled activation — no invoice is
    // created downstream). Reject only a missing/non-numeric/negative amount.
    if (
      amount === undefined ||
      amount === null ||
      typeof amount !== "number" ||
      Number.isNaN(amount) ||
      amount < 0 ||
      !currency ||
      !contract_type
    ) {
      return NextResponse.json(
        { error: "Missing or invalid fields: amount (>= 0), currency, contract_type" },
        { status: 400 }
      )
    }

    // 1. Resolve the offer first when possible — it's the canonical source of
    // account_id, lead_id, and client info. Resolution priority:
    //   offer_token > lead_id (latest offer for that lead) > account_id (latest
    //   non-expired offer for that account) > contact_id (latest non-expired
    //   offer where client_email matches the contact's email).
    type ResolvedOffer = {
      token: string
      status: string | null
      contract_type: string | null
      bundled_pipelines: unknown
      cost_summary: unknown
      client_email: string | null
      client_name: string | null
      services: unknown
      account_id: string | null
      lead_id: string | null
    }
    const offerSelect =
      "token, status, contract_type, bundled_pipelines, cost_summary, client_email, client_name, services, account_id, lead_id"
    let offer: ResolvedOffer | null = null

    if (offer_token) {
      const { data } = await supabaseAdmin
        .from("offers")
        .select(offerSelect)
        .eq("token", offer_token)
        .maybeSingle()
      offer = (data as ResolvedOffer | null) ?? null
      if (!offer) {
        return NextResponse.json({ error: `Offer not found: ${offer_token}` }, { status: 404 })
      }
    } else if (lead_id) {
      const { data } = await supabaseAdmin
        .from("offers")
        .select(offerSelect)
        .eq("lead_id", lead_id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()
      offer = (data as ResolvedOffer | null) ?? null
    } else if (account_id) {
      // Existing-account re-entry (Mojo case): pick most recent non-expired offer.
      const { data } = await supabaseAdmin
        .from("offers")
        .select(offerSelect)
        .eq("account_id", account_id)
        .neq("status", "expired")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()
      offer = (data as ResolvedOffer | null) ?? null
      if (!offer) {
        return NextResponse.json(
          { error: `No offer found for account ${account_id}. Create an offer first, then confirm payment.` },
          { status: 404 }
        )
      }
    } else if (contact_id) {
      // Existing-contact re-entry: offers has no contact_id FK, so we resolve
      // via the contact's email. (Tracked structurally in DT-F.)
      const { data: contact, error: cErr } = await supabaseAdmin
        .from("contacts")
        .select("id, email")
        .eq("id", contact_id)
        .single()
      if (cErr || !contact?.email) {
        return NextResponse.json(
          { error: `Contact not found or has no email: ${contact_id}` },
          { status: 404 }
        )
      }
      const { data } = await supabaseAdmin
        .from("offers")
        .select(offerSelect)
        .ilike("client_email", contact.email)
        .neq("status", "expired")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()
      offer = (data as ResolvedOffer | null) ?? null
      if (!offer) {
        return NextResponse.json(
          { error: `No offer found for contact ${contact_id} (email match against offers.client_email).` },
          { status: 404 }
        )
      }
    }

    // 2. Resolve lead (only if a lead_id is known — directly or via offer)
    const effectiveLeadId: string | null = offer?.lead_id || lead_id || null
    type ResolvedLead = {
      id: string
      full_name: string | null
      email: string | null
      phone: string | null
      language: string | null
      status: string | null
    }
    let lead: ResolvedLead | null = null
    if (effectiveLeadId) {
      const { data, error: leadErr } = await supabaseAdmin
        .from("leads")
        .select("id, full_name, email, phone, language, status")
        .eq("id", effectiveLeadId)
        .single()
      if (leadErr || !data) {
        return NextResponse.json({ error: `Lead not found: ${effectiveLeadId}` }, { status: 404 })
      }
      lead = data as ResolvedLead
    }

    // 3. Mode 2 (manual without offer) is only valid for the lead_id path.
    // Account / contact / offer_token paths require a real offer.
    if (!offer && !effectiveLeadId) {
      return NextResponse.json(
        { error: "An offer is required when confirming payment by account_id, contact_id, or offer_token." },
        { status: 400 }
      )
    }

    // Display fields — prefer offer (more specific) then fall back to lead.
    const clientName: string = offer?.client_name || lead?.full_name || "Unknown client"
    const clientEmail: string | null = offer?.client_email || lead?.email || null

    // d715e5e5: no "already Converted" pre-gate. offer-signed no longer flips
    // lead.status to "Converted" on sign, so the only authoritative "already
    // done" signal is pending_activations.status === "activated", handled at
    // the activation lookup below.

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

    // Locate the pending_activation. Prefer offer.token (most specific —
    // pending_activations has a 1:1 relationship to offer_token via
    // offer-signed). Fall back to lead_id for legacy leads with no offer.
    // portal_invoice_id is read so the raw payments insert below can be skipped
    // when offer-signed already created a draft invoice (activate-service flips
    // it to Paid; inserting again creates a duplicate).
    let existingActivationQuery = supabaseAdmin
      .from("pending_activations")
      .select("id, status, portal_invoice_id")
      .order("created_at", { ascending: false })
      .limit(1)
    if (offer?.token) {
      existingActivationQuery = existingActivationQuery.eq("offer_token", offer.token)
    } else if (effectiveLeadId) {
      existingActivationQuery = existingActivationQuery.eq("lead_id", effectiveLeadId)
    }
    const { data: existingActivation } = await existingActivationQuery.maybeSingle()

    if (existingActivation) {
      if (existingActivation.status === "activated") {
        return NextResponse.json(
          { error: "This offer's activation is already complete. Check the contact/account." },
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
      // No pending_activation exists. Cases:
      //  - Legacy lead, no offer signed → admin creates the activation directly.
      //  - Existing-account / existing-contact / offer_token path where
      //    offer-signed didn't run → use the resolved offer.token.
      const adminFallbackToken = effectiveLeadId
        ? `admin-${effectiveLeadId.slice(0, 8)}`
        : `admin-${(offer?.account_id || "noref").slice(0, 8)}-${Date.now()}`
      const { data: newActivation, error: createErr } = await supabaseAdmin
        .from("pending_activations")
        .insert({
          offer_token: offer?.token || adminFallbackToken,
          lead_id: effectiveLeadId,
          client_name: clientName,
          client_email: clientEmail,
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
    } else if (!offer && bundled_pipelines?.length > 0 && effectiveLeadId && lead) {
      // Mode 2 (legacy lead, no offer) — create a minimal offer record so
      // activate-service can read it. Only valid for the lead path; the
      // account/contact/offer_token paths are gated above to require a real
      // offer.
      const fallbackToken = `admin-${effectiveLeadId.slice(0, 8)}-${Date.now()}`
      await supabaseAdmin
        .from("offers")
        .insert({
          token: fallbackToken,
          lead_id: effectiveLeadId,
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
        .update({ offer_token: fallbackToken })
        .eq("id", activationId)
    }

    // 5. Resolve account + contact for the payment record.
    // Priority: offer.account_id (most specific) > body.account_id > resolved
    // via email lookup. Contact: lookup by clientEmail.
    let resolvedAccountId: string | null = offer?.account_id || account_id || null
    let resolvedContactId: string | null = contact_id || null
    if (clientEmail) {
      const { data: contact } = await supabaseAdmin
        .from("contacts")
        .select("id")
        .ilike("email", clientEmail)
        .limit(1)
        .maybeSingle()
      if (contact) {
        if (!resolvedContactId) resolvedContactId = contact.id
        if (!resolvedAccountId) {
          const { data: ac } = await supabaseAdmin
            .from("account_contacts")
            .select("account_id")
            .eq("contact_id", contact.id)
            .limit(1)
            .maybeSingle()
          resolvedAccountId = ac?.account_id || null
        }
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
    if (!existingActivation?.portal_invoice_id && amount > 0) {
      try {
        const { createTDInvoice } = await import("@/lib/portal/td-invoice")
        const paidDate = payment_date || new Date().toISOString().split("T")[0]
        const noteParts = [
          payment_reference ? `Ref: ${payment_reference}` : null,
          paid_by_name ? `Paid by: ${paid_by_name}` : null,
          effectiveLeadId
            ? `Admin-confirmed payment for legacy lead.`
            : `Admin-confirmed payment for existing-account/contact offer.`,
        ].filter(Boolean)
        // Idempotency anchor — prefer offer.token (most specific), fall back
        // to lead_id, then account_id, then contact_id.
        const idempotencyAnchor =
          offer?.token ||
          (effectiveLeadId ? `lead:${effectiveLeadId}` : null) ||
          (resolvedAccountId ? `account:${resolvedAccountId}` : null) ||
          (resolvedContactId ? `contact:${resolvedContactId}` : "no-anchor")
        const invoiceResult = await createTDInvoice({
          account_id: resolvedAccountId || undefined,
          contact_id: resolvedContactId || undefined,
          line_items: [{
            description: `${contract_type} - ${clientName} (admin confirmed)`,
            unit_price: amount,
            quantity: 1,
          }],
          currency,
          mark_as_paid: true,
          paid_date: paidDate,
          payment_method: payment_method || "wire",
          notes: noteParts.join(". "),
          idempotency_key: `manual-confirm-payment:${idempotencyAnchor}:${paidDate}:${amount}`,
        })
        // Bug 1 fix (master 9e27e14f, sysdoc ops-2026-05-07-onetime-to-active-journey-fix-plan):
        // link the invoice we just created to the activation BEFORE calling
        // activate-service. Otherwise activate-service Step 3 sees
        // activation.portal_invoice_id=null and falls through to its own
        // createTDInvoice fallback (route.ts:905-948) — different code path,
        // no shared idempotency key, two Paid invoices land for one wire.
        // Mojo sandbox 2026-05-07: INV-002192 + INV-002193 both Paid $2000.
        if (invoiceResult?.paymentId && activationId) {
          await supabaseAdmin
            .from("pending_activations")
            .update({ portal_invoice_id: invoiceResult.paymentId })
            .eq("id", activationId)
        }
      } catch (invErr) {
        console.error("[confirm-payment] createTDInvoice failed:", invErr)
        logAction({
          actor: "crm-admin",
          action_type: "error",
          table_name: "payments",
          summary: `Invoice creation failed for ${clientName}: ${invErr instanceof Error ? invErr.message : String(invErr)}`,
          details: {
            lead_id: effectiveLeadId,
            account_id: resolvedAccountId,
            contact_id: resolvedContactId,
            offer_token: offer?.token,
            error: invErr instanceof Error ? invErr.message : String(invErr),
          },
        })
      }
    }

    // 6. Update lead status — only when a lead exists. Account / contact
    // re-entry has no lead; nothing to flip.
    if (effectiveLeadId) {
      await supabaseAdmin
        .from("leads")
        .update({
          status: "Converted",
          updated_at: new Date().toISOString(),
        })
        .eq("id", effectiveLeadId)
    }

    // 7. Call activate-service (SAME chain as Whop webhook)
    let activationResult = null
    try {
      activationResult = await runActivation(activationId)
    } catch (err) {
      console.error("[confirm-payment] runActivation failed:", err)
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
        const clientFirstWord = (clientName || "").split(/\s+/)[0]?.toLowerCase() || ""

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
      account_id: resolvedAccountId || undefined,
      summary: `Payment confirmed by admin for ${clientName}. ${currency} ${amount} via ${payment_method}. Ref: ${payment_reference || "N/A"}${paid_by_name ? `. Paid by: ${paid_by_name}` : ""}`,
      details: {
        lead_id: effectiveLeadId,
        account_id: resolvedAccountId,
        contact_id: resolvedContactId,
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
        identifier_provided: lead_id ? "lead_id" : account_id ? "account_id" : contact_id ? "contact_id" : "offer_token",
      },
    })

    const activationOk = activationResult && !activationResult.error
    return NextResponse.json({
      ok: true,
      message: activationOk
        ? `Payment confirmed for ${clientName}. Activation chain triggered successfully.`
        : `Payment confirmed for ${clientName}. Activation chain had issues — check action_log.`,
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
