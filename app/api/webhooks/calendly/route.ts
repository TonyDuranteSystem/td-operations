/**
 * Calendly Webhook Endpoint
 *
 * Receives invitee.created events when someone books a call.
 *
 * INTAKE MODE (default):
 *   Stages the booking in webhook_events with enriched parsed data
 *   and review_status='pending_review'. Staff reviews via CRM Intake page.
 *
 * LEGACY MODE (CALENDLY_INTAKE_MODE=auto_create):
 *   Auto-creates or updates a lead in the CRM (original behavior).
 *   Set this env var on Vercel to roll back instantly, no redeploy needed.
 *
 * Setup:
 *   1. Go to calendly.com → Integrations → Webhooks
 *   2. Add webhook URL: <vercel-deployment>/api/webhooks/calendly
 *   3. Subscribe to: invitee.created
 *   4. Copy signing key → set CALENDLY_WEBHOOK_SECRET env var (optional)
 */

import { NextRequest, NextResponse } from "next/server"
import { createClient, SupabaseClient } from "@supabase/supabase-js"

let _supabase: SupabaseClient | null = null
function getSupabase() {
  if (!_supabase) {
    _supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _supabase
}

// ─── Signature Verification ─────────────────────────────────

async function verifyCalendlySignature(
  body: string,
  signatureHeader: string | null
): Promise<boolean> {
  const secret = process.env.CALENDLY_WEBHOOK_SECRET
  if (!secret) {
    console.warn("[calendly-webhook] CALENDLY_WEBHOOK_SECRET not set — skipping verification")
    return true
  }

  if (!signatureHeader) {
    console.error("[calendly-webhook] Missing Calendly-Webhook-Signature header")
    return false
  }

  // Calendly sends: t=<timestamp>,v1=<signature>
  const parts: Record<string, string> = {}
  for (const pair of signatureHeader.split(",")) {
    const [key, val] = pair.split("=", 2)
    if (key && val) parts[key] = val
  }

  const timestamp = parts["t"]
  const expectedSig = parts["v1"]
  if (!timestamp || !expectedSig) {
    console.error("[calendly-webhook] Malformed signature header")
    return false
  }

  // Reject old timestamps (5 min tolerance)
  const ts = parseInt(timestamp, 10)
  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - ts) > 300) {
    console.error("[calendly-webhook] Timestamp too old:", ts, "now:", now)
    return false
  }

  const toSign = `${timestamp}.${body}`
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(toSign))
  const computedHex = Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("")

  if (computedHex !== expectedSig) {
    console.error("[calendly-webhook] Signature mismatch")
    return false
  }

  return true
}

// ─── Shared: extract invitee fields ─────────────────────────

function extractInviteeFields(payload: Record<string, unknown>) {
  const invitee = (payload.payload as Record<string, unknown>)?.invitee as Record<string, unknown> | undefined
  if (!invitee?.email) return null

  const email = (invitee.email as string).toLowerCase().trim()
  const name = (invitee.name as string) || email.split("@")[0]
  const phone = (invitee.phone_number as string) || null

  let callDate: string | null = null
  const scheduledEvent = (payload.payload as Record<string, unknown>)?.scheduled_event as Record<string, unknown> | undefined
  if (scheduledEvent?.start_time) {
    callDate = (scheduledEvent.start_time as string).split("T")[0]
  }

  const qAndA = invitee.questions_and_answers as Array<{ question: string; answer: string }> | undefined
  let reason: string | null = null
  let referrerName: string | null = null
  if (qAndA?.length) {
    for (const qa of qAndA) {
      const q = qa.question.toLowerCase()
      if (q.includes("hear about") || q.includes("referral") || q.includes("come ci hai")) {
        referrerName = qa.answer || null
      } else if (q.includes("reason") || q.includes("motivo") || q.includes("help") || q.includes("interest")) {
        reason = qa.answer || null
      }
    }
    if (!reason && qAndA.length > 0 && !referrerName) {
      reason = qAndA[0].answer || null
    }
  }

  const eventUri = (payload.payload as Record<string, unknown>)?.event as string | undefined

  return {
    email,
    name,
    phone,
    callDate,
    reason,
    referrerName,
    eventUri: eventUri || null,
    eventTypeName: (scheduledEvent?.name as string) || null,
  }
}

// ─── Main Handler ───────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const body = await req.text()
    const signatureHeader = req.headers.get("Calendly-Webhook-Signature")

    const valid = await verifyCalendlySignature(body, signatureHeader)
    if (!valid) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 })
    }

    const payload = JSON.parse(body)

    if (payload.event !== "invitee.created") {
      // Log non-invitee events without processing
      await getSupabase().from("webhook_events").insert({
        source: "calendly",
        event_type: payload.event || "unknown",
        external_id: payload.payload?.uri || "unknown",
        payload,
      })
      return NextResponse.json({ ignored: true, event: payload.event })
    }

    const fields = extractInviteeFields(payload)
    if (!fields) {
      return NextResponse.json({ error: "No invitee email" }, { status: 400 })
    }

    const db = getSupabase()

    // Check for existing lead/contact (used by both modes)
    const { data: existingLeads } = await db
      .from("leads")
      .select("id, status")
      .ilike("email", fields.email)
      .limit(1)

    const { data: existingContacts } = await db
      .from("contacts")
      .select("id, full_name")
      .ilike("email", fields.email)
      .limit(1)

    // ─── Mode selection ─────────────────────────────────────
    // Default: 'staging' (intake review). Set CALENDLY_INTAKE_MODE=auto_create to rollback.
    const intakeMode = process.env.CALENDLY_INTAKE_MODE || "staging"

    if (intakeMode !== "auto_create") {
      // ─── INTAKE STAGING MODE (new default) ────────────────
      const enrichedPayload = {
        raw: payload,
        parsed: {
          name: fields.name,
          email: fields.email,
          phone: fields.phone,
          call_date: fields.callDate,
          reason: fields.reason,
          referrer_name: fields.referrerName,
          event_uri: fields.eventUri,
          event_type_name: fields.eventTypeName,
        },
        matches: {
          existing_lead_id: existingLeads?.[0]?.id || null,
          existing_lead_status: existingLeads?.[0]?.status || null,
          existing_contact_id: existingContacts?.[0]?.id || null,
          existing_contact_name: existingContacts?.[0]?.full_name || null,
        },
      }

      const reviewStatus = existingLeads?.[0] ? "auto_linked" : "pending_review"

      await db.from("webhook_events").insert({
        source: "calendly",
        event_type: "invitee.created",
        external_id: payload.payload?.uri || "unknown",
        payload: enrichedPayload,
        review_status: reviewStatus,
      })

      console.warn(
        `[calendly-webhook] Intake staged: ${fields.name} (${fields.email}) — ` +
        `review_status=${reviewStatus}, ` +
        `existing_lead=${existingLeads?.[0]?.id || "none"}, ` +
        `existing_contact=${existingContacts?.[0]?.id || "none"}`
      )

      return NextResponse.json({
        action: "staged",
        review_status: reviewStatus,
        mode: "staging",
      })
    }

    // ─── LEGACY AUTO-CREATE MODE ────────────────────────────
    // Activated by: CALENDLY_INTAKE_MODE=auto_create
    // Preserves exact original behavior for rollback safety.

    await db.from("webhook_events").insert({
      source: "calendly",
      event_type: payload.event || "unknown",
      external_id: payload.payload?.uri || "unknown",
      payload,
    })

    if (existingLeads && existingLeads.length > 0) {
      const lead = existingLeads[0]
      const earlyStatuses = ["New", "Call Scheduled"]
      const updates: Record<string, unknown> = {
        status: earlyStatuses.includes(lead.status) ? "Call Scheduled" : lead.status,
        updated_at: new Date().toISOString(),
      }
      if (fields.callDate) updates.call_date = fields.callDate
      if (fields.phone && !lead.status) updates.phone = fields.phone

      await db.from("leads").update(updates).eq("id", lead.id)

      console.warn(`[calendly-webhook] [legacy] Updated existing lead ${lead.id} — ${fields.name} (${fields.email})`)
      return NextResponse.json({ lead_id: lead.id, action: "updated" })
    }

    if (existingContacts && existingContacts.length > 0) {
      console.warn(`[calendly-webhook] [legacy] Existing contact found: ${existingContacts[0].full_name} — creating lead anyway`)
    }

    const leadRecord: Record<string, unknown> = {
      full_name: fields.name,
      email: fields.email,
      source: "Calendly",
      channel: "Calendly",
      status: "Call Scheduled",
      notes: fields.eventUri ? `Calendly event: ${fields.eventUri}` : "Booked via Calendly",
    }
    if (fields.phone) leadRecord.phone = fields.phone
    if (fields.callDate) leadRecord.call_date = fields.callDate
    if (fields.reason) leadRecord.reason = fields.reason
    if (fields.referrerName) leadRecord.referrer_name = fields.referrerName

    const { data: newLead, error: insertErr } = await db
      .from("leads")
      .insert(leadRecord)
      .select("id")
      .single()

    if (insertErr) {
      console.error("[calendly-webhook] [legacy] Failed to create lead:", insertErr.message)
      return NextResponse.json({ error: insertErr.message }, { status: 500 })
    }

    console.warn(`[calendly-webhook] [legacy] Created new lead ${newLead.id} — ${fields.name} (${fields.email})`)
    return NextResponse.json({ lead_id: newLead.id, action: "created" })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[calendly-webhook] Error:", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
