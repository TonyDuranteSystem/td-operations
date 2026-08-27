/**
 * POST /api/crm/admin-actions/activate-now
 *
 * Owner/admin action to ACTIVATE a signed contract regardless of payment
 * state. This deliberately DECOUPLES activation from payment: the owner can
 * turn a client's services on based on a receipt / their own judgment, and
 * link the money later (bank-feed match or manual payment).
 *
 * How it differs from confirm-payment:
 *   - confirm-payment records a payment AND activates (payment-first flow).
 *   - activate-now ONLY activates. It never records a payment and never marks
 *     the activation paid, so `payment_confirmed_at` stays NULL — AR / dunning
 *     still sees the contract as owing money until a real payment is linked.
 *
 * Identifier — provide ONE of:
 *   - offer_token (most specific)
 *   - account_id  (resolves the latest non-expired offer on the account)
 *
 * Behavior:
 *   1. Resolve the offer.
 *   2. Find the pending_activation for that offer; create one (awaiting_payment)
 *      if none exists yet.
 *   3. Call runActivation() directly — the same engine the webhooks use. It is
 *      idempotent (returns "Already activated" when activated_at is set) and
 *      does not require any amount/payment.
 *   4. Log to action_log.
 */

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { canPerform } from "@/lib/permissions"
import { logAction } from "@/lib/mcp/action-log"
import { runActivation } from "@/lib/operations/activate-service"
import { normalizeFormationState } from "@/lib/formation/states"

interface ActivateNowBody {
  offer_token?: string
  account_id?: string
  note?: string
}

export async function POST(request: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!canPerform(user, "confirm_payment")) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 })
  }

  try {
    const body: ActivateNowBody = await request.json()
    const { offer_token, account_id, note } = body

    if (!offer_token && !account_id) {
      return NextResponse.json(
        { error: "Provide one of: offer_token, account_id" },
        { status: 400 },
      )
    }

    // 1. Resolve the offer (token is most specific; otherwise latest
    // non-expired offer on the account).
    const offerSelect =
      "token, status, client_name, client_email, account_id, lead_id, formation_state"
    type ResolvedOffer = {
      token: string
      status: string | null
      client_name: string | null
      client_email: string | null
      account_id: string | null
      lead_id: string | null
      formation_state: string | null
    }
    let offer: ResolvedOffer | null = null

    if (offer_token) {
      // A token can have more than one offer row (versioned / re-sent offers),
      // so order by recency + limit(1) — maybeSingle() alone errors on >1 row.
      const { data } = await supabaseAdmin
        .from("offers")
        // eslint-disable-next-line no-restricted-syntax -- formation_state is a real offers column missing from the stale generated types (same gap confirm-payment works around)
        .select(offerSelect as never)
        .eq("token", offer_token)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()
      offer = (data as unknown as ResolvedOffer | null) ?? null
      if (!offer) {
        return NextResponse.json({ error: `Offer not found: ${offer_token}` }, { status: 404 })
      }
    } else {
      const { data } = await supabaseAdmin
        .from("offers")
        // eslint-disable-next-line no-restricted-syntax -- formation_state is a real offers column missing from the stale generated types (same gap confirm-payment works around)
        .select(offerSelect as never)
        .eq("account_id", account_id as string)
        .neq("status", "expired")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()
      offer = (data as unknown as ResolvedOffer | null) ?? null
      if (!offer) {
        return NextResponse.json(
          { error: `No offer found for account ${account_id}. Create and sign an offer first.` },
          { status: 404 },
        )
      }
    }

    // 2. Find or create the pending_activation for this offer.
    const { data: existing } = await supabaseAdmin
      .from("pending_activations")
      .select("id, status, activated_at")
      .eq("offer_token", offer.token)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    let activationId: string
    if (existing) {
      if (existing.activated_at || existing.status === "activated") {
        return NextResponse.json(
          { ok: true, already_activated: true, message: "Contract is already activated." },
        )
      }
      activationId = existing.id
    } else {
      const { data: created, error: createErr } = await supabaseAdmin
        .from("pending_activations")
        .insert({
          offer_token: offer.token,
          lead_id: offer.lead_id,
          // client_name / client_email are NOT NULL in the schema — fall back
          // to safe placeholders if the offer somehow lacks them.
          client_name: offer.client_name || "Unknown client",
          client_email: offer.client_email || "unknown@tonydurante.us",
          // Same gap the confirm-payment admin action had: without this, a
          // client's real picked state (or any signed formation offer's
          // state) is lost and the formation wizard silently defaults to
          // New Mexico regardless of what was actually agreed.
          formation_state: normalizeFormationState(offer.formation_state),
          status: "awaiting_payment",
          payment_method: "none",
          notes: [
            "Created by Activate Now (payment decoupled).",
            note ? `Note: ${note}` : null,
          ].filter(Boolean).join(" "),
        })
        .select("id")
        .single()
      if (createErr || !created) {
        return NextResponse.json(
          { error: `Failed to create activation: ${createErr?.message}` },
          { status: 500 },
        )
      }
      activationId = created.id
    }

    // 3. Run the activation engine directly (no payment required).
    let activationResult = null
    try {
      activationResult = await runActivation(activationId)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logAction({
        actor: "crm-admin",
        action_type: "error",
        table_name: "pending_activations",
        record_id: activationId,
        account_id: offer.account_id || account_id || undefined,
        summary: `Activate Now failed for ${offer.client_name || offer.token}: ${msg}`,
        details: { offer_token: offer.token, error: msg, admin_email: user?.email },
      })
      return NextResponse.json({ error: msg }, { status: 500 })
    }

    const activationOk = activationResult && !activationResult.error

    // 4. Log.
    logAction({
      actor: "crm-admin",
      action_type: "activate_now",
      table_name: "pending_activations",
      record_id: activationId,
      account_id: offer.account_id || account_id || undefined,
      summary: `Activate Now (payment decoupled) for ${offer.client_name || offer.token}.${note ? ` Note: ${note}` : ""}`,
      details: {
        offer_token: offer.token,
        activation_id: activationId,
        note: note || null,
        activation_result: activationResult,
        payment_recorded: false,
        admin_email: user?.email,
      },
    })

    return NextResponse.json({
      ok: true,
      activation_id: activationId,
      activation_ok: activationOk,
      activation_result: activationResult,
      message: activationOk
        ? `Contract activated for ${offer.client_name || offer.token}. Payment not recorded — link it when it arrives.`
        : `Activation ran with issues for ${offer.client_name || offer.token} — check action_log.`,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error("[activate-now] Error:", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
