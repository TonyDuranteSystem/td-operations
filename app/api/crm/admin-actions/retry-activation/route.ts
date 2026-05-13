/**
 * POST /api/crm/admin-actions/retry-activation
 *
 * Admin-only endpoint to retry stuck pending_activations.
 * Accepts activations in retryable states: payment_confirmed, awaiting_payment,
 * pending_confirmation.
 *
 * Calls runActivation() directly — no internal HTTP hop.
 */

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { runActivation } from "@/lib/operations/activate-service"

export async function POST(req: NextRequest) {
  // Require authenticated admin session
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { pending_activation_id } = await req.json()
  if (!pending_activation_id) {
    return NextResponse.json({ error: "Missing pending_activation_id" }, { status: 400 })
  }

  // Verify it's in a retryable state
  const { data: activation } = await supabaseAdmin
    .from("pending_activations")
    .select("id, status, client_name, offer_token")
    .eq("id", pending_activation_id)
    .single()

  if (!activation) {
    return NextResponse.json({ error: "Activation not found" }, { status: 404 })
  }

  if (activation.status === "activated") {
    return NextResponse.json({ ok: true, message: "Already activated" })
  }

  // Allow retry from payment_confirmed, awaiting_payment, pending_confirmation
  const retryableStatuses = ["payment_confirmed", "awaiting_payment", "pending_confirmation"]
  if (!retryableStatuses.includes(activation.status)) {
    return NextResponse.json({
      error: `Cannot retry activation with status '${activation.status}'`
    }, { status: 400 })
  }

  try {
    const result = await runActivation(pending_activation_id)
    return NextResponse.json(result)
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
