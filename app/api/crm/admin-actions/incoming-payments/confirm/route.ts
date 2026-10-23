/**
 * POST /api/crm/admin-actions/incoming-payments/confirm
 *
 * Staff say what an unlabelled Stripe payment was (Calendar → Payments to confirm). Body:
 *   { session_id, resolution: "paid_call" | "paid_call_already_deducted" | "recorded_elsewhere" | "marketing_sale" | "invoice_paid",
 *     lead_id?, note?, marketing_lead_id? + sale_kind? (marketing_sale), invoice_payment_id? (invoice_paid) }
 * The money (amount, currency, payer, Stripe ids) is re-read server-side from the saved Stripe event — never from this body.
 * Same permission as Confirm Payment. See lib/incoming-payments/confirm.ts.
 */

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { canPerform } from "@/lib/permissions"
import { logAction } from "@/lib/mcp/action-log"
import { confirmIncomingPayment } from "@/lib/incoming-payments/confirm"

export async function POST(request: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!canPerform(user, "confirm_payment")) return NextResponse.json({ error: "You do not have permission to confirm payments." }, { status: 403 })

  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const actor = user.email ?? user.id
  const result = await confirmIncomingPayment({
    sessionId: String(body.session_id ?? "").trim(),
    resolution: body.resolution,
    leadId: typeof body.lead_id === "string" ? body.lead_id : null,
    note: typeof body.note === "string" ? body.note : null,
    marketingLeadId: typeof body.marketing_lead_id === "string" ? body.marketing_lead_id : null,
    saleKind: typeof body.sale_kind === "string" ? body.sale_kind : null,
    invoicePaymentId: typeof body.invoice_payment_id === "string" ? body.invoice_payment_id : null,
    actor,
  })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

  if (!result.alreadySettled) {
    logAction({
      actor: "crm-admin",
      action_type: "incoming_payment_confirmed",
      table_name: "incoming_payment_resolutions",
      record_id: String(body.session_id),
      summary: `Unlabelled Stripe payment confirmed as ${result.resolution} by ${actor}`,
      details: { resolution: result.resolution, invoice_number: result.invoiceNumber ?? null, credit_number: result.creditNumber ?? null, contact_id: result.contactId ?? null },
    })
  }
  return NextResponse.json(result)
}
