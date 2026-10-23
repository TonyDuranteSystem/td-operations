/**
 * POST /api/crm/admin-actions/payment-links/create
 *
 * Make a Stripe card payment link for a CRM lead, with a FREE amount, currency and description (incoming-payments Phase 2).
 * Body: { lead_id, amount, currency: "EUR"|"USD", description?, purpose: "paid_call"|"other", confirmed? }
 *   paid_call -> the link is labelled; when paid, the webhook records the paid call + a deductible credit by itself.
 *   other     -> no label; when paid it waits in Calendar → Payments to confirm.
 * Nothing is sent to the client: staff copy the link and send it themselves. The link lives 23 hours (Stripe's checkout limit is 24).
 */

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { canPerform } from "@/lib/permissions"
import { logAction } from "@/lib/mcp/action-log"
import { createMarketingCheckoutSession } from "@/lib/stripe-checkout"
import { linkMetadata, parseLinkRequest } from "@/lib/incoming-payments/payment-link"

export async function POST(request: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!canPerform(user, "create_offer")) return NextResponse.json({ error: "You do not have permission to create payment links." }, { status: 403 })

  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const parsed = parseLinkRequest(body)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
  if (parsed.needsConfirm) {
    return NextResponse.json({ error: "That is a large amount: tick the box to confirm it is right.", needsConfirm: true }, { status: 400 })
  }
  const req = parsed.value

  const { data: lead, error: leadErr } = await supabaseAdmin.from("leads").select("id, full_name, email, notes").eq("id", req.leadId).maybeSingle()
  if (leadErr) return NextResponse.json({ error: `Could not read the lead: ${leadErr.message}` }, { status: 500 })
  if (!lead) return NextResponse.json({ error: "Lead not found." }, { status: 404 })
  const l = lead as { id: string; full_name: string | null; email: string | null; notes: string | null }

  const session = await createMarketingCheckoutSession({
    amountCents: req.amountCents,
    currency: req.currency,
    productName: req.description,
    clientEmail: l.email,
    metadata: linkMetadata(req, l.email),
  })
  if (!session.success || !session.checkoutUrl) {
    return NextResponse.json({ error: `Stripe could not create the link: ${session.error ?? "no link returned"}` }, { status: 502 })
  }

  const actor = user.email ?? user.id
  const money = `${req.currency === "EUR" ? "€" : "$"}${(req.amountCents / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`
  const kind = req.purpose === "paid_call" ? "paid call" : "payment to confirm"
  const line = `${new Date().toISOString().slice(0, 10)}: ${money} payment link created by ${actor} (${kind}: ${req.description}).`
  // CRM update rule: the lead's own record says a link was made. A failed note must not hide a link that already exists.
  const { error: noteErr } = await supabaseAdmin.from("leads").update({ notes: l.notes ? `${l.notes}\n${line}` : line }).eq("id", l.id)
  if (noteErr) console.error("[payment-links/create] could not add the note line to lead", l.id, noteErr.message)

  logAction({
    actor: "crm-admin",
    action_type: "payment_link_created",
    table_name: "leads",
    record_id: l.id,
    summary: `Payment link ${money} (${kind}) created for lead "${l.full_name ?? l.id}" by ${actor}`,
    details: { purpose: req.purpose, amount_cents: req.amountCents, currency: req.currency, description: req.description, session_id: session.sessionId },
  })

  return NextResponse.json({ ok: true, url: session.checkoutUrl, expiresAt: session.expiresAt?.toISOString() ?? null, purpose: req.purpose })
}
