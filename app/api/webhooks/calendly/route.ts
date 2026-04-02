/**
 * Calendly Webhook Endpoint
 *
 * Receives invitee.created events when someone books a call.
 * Auto-creates or updates a lead in the CRM.
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

    // Log webhook event
    await getSupabase().from("webhook_events").insert({
      source: "calendly",
      event_type: payload.event || "unknown",
      external_id: payload.payload?.uri || "unknown",
      payload,
    })

    if (payload.event !== "invitee.created") {
      return NextResponse.json({ ignored: true, event: payload.event })
    }

    const invitee = payload.payload?.invitee
    if (!invitee?.email) {
      return NextResponse.json({ error: "No invitee email" }, { status: 400 })
    }

    const email = invitee.email.toLowerCase().trim()
    const name = invitee.name || email.split("@")[0]
    const phone = invitee.phone_number || null

    // Extract scheduled event start time
    const eventUri = payload.payload?.event
    let callDate: string | null = null
    if (payload.payload?.scheduled_event?.start_time) {
      callDate = payload.payload.scheduled_event.start_time.split("T")[0]
    }

    // Parse questions & answers
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
      // If no specific reason found, use the first answer as reason
      if (!reason && qAndA.length > 0 && !referrerName) {
        reason = qAndA[0].answer || null
      }
    }

    const db = getSupabase()

    // Check if lead already exists by email
    const { data: existingLeads } = await db
      .from("leads")
      .select("id, status")
      .ilike("email", email)
      .limit(1)

    if (existingLeads && existingLeads.length > 0) {
      const lead = existingLeads[0]
      // Update existing lead to Call Scheduled (only if in early stage)
      const earlyStatuses = ["New", "Call Scheduled"]
      const updates: Record<string, unknown> = {
        status: earlyStatuses.includes(lead.status) ? "Call Scheduled" : lead.status,
        updated_at: new Date().toISOString(),
      }
      if (callDate) updates.call_date = callDate
      if (phone && !lead.status) updates.phone = phone

      await db.from("leads").update(updates).eq("id", lead.id)

      console.warn(`[calendly-webhook] Updated existing lead ${lead.id} — ${name} (${email})`)
      return NextResponse.json({ lead_id: lead.id, action: "updated" })
    }

    // Check if contact exists (already a client)
    const { data: existingContacts } = await db
      .from("contacts")
      .select("id, full_name")
      .ilike("email", email)
      .limit(1)

    if (existingContacts && existingContacts.length > 0) {
      // Existing client booking a call — create lead linked to their info
      console.warn(`[calendly-webhook] Existing contact found: ${existingContacts[0].full_name} — creating lead anyway`)
    }

    // Create new lead
    const leadRecord: Record<string, unknown> = {
      full_name: name,
      email,
      source: "Calendly",
      channel: "Calendly",
      status: "Call Scheduled",
      notes: eventUri ? `Calendly event: ${eventUri}` : "Booked via Calendly",
    }
    if (phone) leadRecord.phone = phone
    if (callDate) leadRecord.call_date = callDate
    if (reason) leadRecord.reason = reason
    if (referrerName) leadRecord.referrer_name = referrerName

    const { data: newLead, error: insertErr } = await db
      .from("leads")
      .insert(leadRecord)
      .select("id")
      .single()

    if (insertErr) {
      console.error("[calendly-webhook] Failed to create lead:", insertErr.message)
      return NextResponse.json({ error: insertErr.message }, { status: 500 })
    }

    console.warn(`[calendly-webhook] Created new lead ${newLead.id} — ${name} (${email})`)
    return NextResponse.json({ lead_id: newLead.id, action: "created" })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[calendly-webhook] Error:", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
