/**
 * Calendly Webhook Endpoint
 *
 * Receives invitee.created events when someone books a call.
 *
 * AUTO-CREATE MODE (default):
 *   A booking immediately becomes a lead in the CRM (existing leads are updated,
 *   not duplicated) and referral attribution is created when the booking came
 *   through a referral link.
 *
 * STAGING MODE (CALENDLY_INTAKE_MODE=staging):
 *   Stages the booking in webhook_events with enriched parsed data and
 *   review_status='pending_review'. Staff reviews via CRM Intake page.
 *   Set this env var on Vercel to switch back instantly, no redeploy needed.
 *
 * Setup:
 *   1. Go to calendly.com → Integrations → Webhooks
 *   2. Add webhook URL: <vercel-deployment>/api/webhooks/calendly
 *   3. Subscribe to: invitee.created
 *   4. Copy signing key → set CALENDLY_WEBHOOK_SECRET env var (optional)
 */

import { NextRequest, NextResponse } from "next/server"
import { createClient, SupabaseClient } from "@supabase/supabase-js"
import { extractInviteeFields, buildLeadNotes } from "@/lib/calendly/parse-invitee"
import { createPendingReferral } from "@/lib/operations/referral"
import { notifyReferrerLinked } from "@/lib/operations/referral-notify"
import { extractPaidBooking } from "@/lib/calendly/paid-booking"
import { recordPaidCall } from "@/lib/operations/paid-call-credit"
import { isEstablishedClientContact } from "@/lib/calendly/existing-client-tag"

// Escape ILIKE metacharacters so a real email containing `_`/`%` can't
// pattern-match an unrelated row (same pattern as app/api/webhooks/circleback/route.ts).
function escapeLikePattern(value: string): string {
  return value.replace(/([%_])/g, "\\$1")
}

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
// Parser lives in lib/calendly/parse-invitee.ts so it is unit-testable
// (Next.js route files may only export GET/POST/etc.). See that file for the
// payload-shape notes (real Calendly v2 vs legacy nested invitee).

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

    // Check for existing lead/contact (used by both modes). Escaped +
    // deterministically ordered (oldest first) so a real email containing a
    // wildcard character, or a legacy duplicate row, can't flip which row
    // this booking is matched against on different deliveries.
    const escapedEmail = escapeLikePattern(fields.email)
    const { data: existingLeads } = await db
      .from("leads")
      .select("id, status")
      .ilike("email", escapedEmail)
      .order("created_at", { ascending: true })
      .limit(1)

    const { data: existingContacts } = await db
      .from("contacts")
      .select("id, full_name, portal_tier")
      .ilike("email", escapedEmail)
      .order("created_at", { ascending: true })
      .limit(1)

    // ─── Mode selection ─────────────────────────────────────
    // Default: 'auto_create' — a booking immediately becomes a lead (+ referral
    // attribution). Set CALENDLY_INTAKE_MODE=staging to route bookings to the
    // Intake review page instead (the older one-click-to-create flow).
    const intakeMode = process.env.CALENDLY_INTAKE_MODE || "auto_create"

    // Resolve a referral code (from the referral landing page → Calendly link)
    // to the referring client. Fail-safe: never block staging on this.
    //
    // ⛔ referrerName/referrerContactId are set ONLY here, from a verified referral
    // CODE resolving to a REAL contact (Antonio, 2026-08-13). Never seeded from a
    // free-text "how did you hear about us" answer — that field no longer exists
    // on the parsed payload (see parse-invitee.ts). If no code resolves, this lead
    // carries no referrer at all; staff choose one deliberately, later, in the
    // offer's Referrer picker.
    let referrerContactId: string | null = null
    let referrerName: string | null = null
    let referralCode: string | null = null
    if (fields.referralCode) {
      try {
        const { data: referrer } = await db
          .from("contacts")
          .select("id, full_name")
          .ilike("referral_code", fields.referralCode)
          .maybeSingle()
        if (referrer) {
          referrerContactId = referrer.id
          referrerName = referrer.full_name || null
          referralCode = fields.referralCode
        }
      } catch {
        /* swallow — attribution is additive */
      }
    }

    if (intakeMode !== "auto_create") {
      // ─── INTAKE STAGING MODE (new default) ────────────────
      const enrichedPayload = {
        raw: payload,
        parsed: {
          name: fields.name,
          first_name: fields.firstName,
          last_name: fields.lastName,
          email: fields.email,
          phone: fields.phone,
          language: fields.language,
          call_date: fields.callDate,
          call_time: fields.callTime,
          timezone: fields.timezone,
          reason: fields.reason,
          referrer_name: referrerName,
          referrer_contact_id: referrerContactId,
          referral_code: referralCode,
          event_uri: fields.eventUri,
          event_type_name: fields.eventTypeName,
          meeting_url: fields.meetingUrl,
          qa: fields.qa,
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

    // ─── AUTO-CREATE MODE ───────────────────────────────────
    // Activated by: CALENDLY_INTAKE_MODE=auto_create
    // A booking immediately becomes a lead (no Intake review step). Existing leads
    // are updated, not duplicated. Referral attribution is created here too (it is
    // otherwise only created in the Intake "Create Lead" step).

    // review_status='auto_created' keeps this row OUT of the Intake review page
    // (which only lists 'pending_review'/'auto_linked' and the processed set) —
    // auto-created bookings already became leads and need no review. Without this,
    // the column default 'pending_review' would clutter the Intake pending list.
    await db.from("webhook_events").insert({
      source: "calendly",
      event_type: payload.event || "unknown",
      external_id: payload.payload?.uri || "unknown",
      payload,
      review_status: "auto_created",
    })

    // ─── WS-A: PAID BOOKING → revenue + a deductible credit ───
    // Detection is structural (a successful payment object), never an event
    // name or an amount. Idempotent on the Stripe charge, so a re-delivery or a
    // reschedule can never mint a second credit. Fail-safe: a paid-call failure
    // must NOT block lead creation — the booking still matters.
    const paidBooking = extractPaidBooking(payload)
    if (paidBooking) {
      try {
        const result = await recordPaidCall({
          payment: paidBooking,
          inviteeEmail: fields.email,
          inviteeName: fields.name,
          callDate: fields.callDate,
        })
        console.warn(
          `[calendly-webhook] paid call recorded: ${result.invoiceNumber} + credit ${result.creditNumber} ` +
          `(${paidBooking.currency} ${paidBooking.amount}) for ${fields.email}` +
          `${result.contactCreated ? " [contact created]" : ""}` +
          `${result.paymentIntentStamped ? "" : " [NO payment-intent link — feed match will be manual]"}`,
        )
      } catch (err) {
        console.error("[calendly-webhook] paid-call recording FAILED:", err instanceof Error ? err.message : String(err))
        try {
          const { reportSystemError } = await import("@/lib/system-errors")
          await reportSystemError({
            source: "server",
            route: "/api/webhooks/calendly",
            message: `Paid call NOT recorded for ${fields.email} (charge ${paidBooking.chargeId}): ${err instanceof Error ? err.message : String(err)}`,
            context: { email: fields.email, charge_id: paidBooking.chargeId, amount: paidBooking.amount, currency: paidBooking.currency },
          })
        } catch { /* best-effort */ }
      }
    }

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

    // Existing contact, no existing lead: this booking is very likely a call
    // with someone who is already a client, not a fresh prospect. The lead
    // is still created — nothing here is skipped, so referral attribution,
    // paid-call recording, Kanban visibility, and the Circleback linking
    // fallback all keep working exactly as they do for anyone else. The only
    // change: if the matched contact looks like an established relationship
    // (not just a stub row), the new lead is tagged (leads.existing_client_contact_id
    // — deliberately NOT converted_to_contact_id, which several other flows
    // treat as "the lead that actually converted into this contact" and must
    // stay pointing at the real one) so diagnose-contact/diagnose-account's
    // "Lead status" check (and the Portal Chats Issues panel that reads it)
    // stops treating it as an open, unconverted sales opportunity.
    let taggedContactId: string | null = null
    if (existingContacts && existingContacts.length > 0) {
      const contact = existingContacts[0] as { id: string; full_name: string; portal_tier: string | null }
      console.warn(`[calendly-webhook] Existing contact found: ${contact.full_name} — creating lead, tagging to contact`)

      const [accountLinkRes, serviceDeliveryRes] = await Promise.all([
        db.from("account_contacts").select("account_id").eq("contact_id", contact.id).limit(1),
        db.from("service_deliveries").select("id").eq("contact_id", contact.id).limit(1),
      ])

      if (
        isEstablishedClientContact({
          portal_tier: contact.portal_tier,
          hasAccountLink: (accountLinkRes.data?.length ?? 0) > 0,
          hasServiceDelivery: (serviceDeliveryRes.data?.length ?? 0) > 0,
        })
      ) {
        taggedContactId = contact.id
      }
    }

    const leadRecord: Record<string, unknown> = {
      full_name: fields.name,
      email: fields.email,
      source: referrerContactId ? "Referral" : "Calendly",
      channel: "Calendly",
      status: "Call Scheduled",
      notes: buildLeadNotes(fields),
      ...(taggedContactId ? { existing_client_contact_id: taggedContactId } : {}),
    }
    if (fields.firstName) leadRecord.first_name = fields.firstName
    if (fields.lastName) leadRecord.last_name = fields.lastName
    if (fields.phone) leadRecord.phone = fields.phone
    if (fields.language) leadRecord.language = fields.language
    if (fields.callDate) leadRecord.call_date = fields.callDate
    if (fields.reason) leadRecord.reason = fields.reason
    if (referrerName) leadRecord.referrer_name = referrerName

    const { data: newLead, error: insertErr } = await db
      .from("leads")
      .insert(leadRecord)
      .select("id")
      .single()

    if (insertErr) {
      console.error("[calendly-webhook] [legacy] Failed to create lead:", insertErr.message)
      return NextResponse.json({ error: insertErr.message }, { status: 500 })
    }

    // Referral attribution: link the referring client to this auto-created lead.
    // Fail-safe — never block lead creation (self-referral / dedup handled in helper).
    if (referrerContactId) {
      try {
        const refRes = await createPendingReferral(
          {
            referrerContactId,
            referredLeadId: newLead.id,
            referredName: fields.name,
            referredEmail: fields.email,
          },
          db
        )
        if (refRes.created) {
          // Tell the referrer their link was registered (chat + email). Fire-and-forget.
          void notifyReferrerLinked({ referralId: refRes.id, referrerContactId, referredLeadId: newLead.id })
        }
      } catch {
        /* attribution is additive — never block lead creation */
      }
    }

    console.warn(`[calendly-webhook] Created new lead ${newLead.id} — ${fields.name} (${fields.email})`)
    return NextResponse.json({
      lead_id: newLead.id,
      action: "created",
      referrer_contact_id: referrerContactId,
    })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[calendly-webhook] Error:", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
