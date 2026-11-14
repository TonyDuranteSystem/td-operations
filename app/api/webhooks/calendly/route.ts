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
import { extractInviteeFields } from "@/lib/calendly/parse-invitee"
import { extractPaidBooking } from "@/lib/calendly/paid-booking"
import { recordPaidCall } from "@/lib/operations/paid-call-credit"
import { isEstablishedClientContact } from "@/lib/calendly/existing-client-tag"
import { runLegacyLeadTail, type LegacyTailHooks } from "@/lib/calendly/legacy-lead-tail"
import { webhookBranchEnabled } from "@/lib/booking-links/switch"
import { resolveLinkPhase1, applyBookingLink, type LinkContext } from "@/lib/booking-links/engine"
import { raiseCallCheck } from "@/lib/booking-links/call-checks"

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

    // ─── Booking links, PHASE 1 (read-only; skipped unless the `booking` switch is live AND the signing secret is set) ───
    // A booking made through a link Antonio created carries the link's id in utm_term. Fail-open: any problem here leaves linkCtx null
    // and the booking is handled exactly as before.
    let linkCtx: LinkContext | null = null
    try {
      if (await webhookBranchEnabled(db, process.env.CALENDLY_WEBHOOK_SECRET)) linkCtx = await resolveLinkPhase1(db, payload)
    } catch (err) {
      console.error("[calendly-webhook] booking-link lookup failed:", err instanceof Error ? err.message : String(err))
      linkCtx = null
    }

    // Check for existing lead/contact (used by both modes). Escaped +
    // deterministically ordered (oldest first) so a real email containing a
    // wildcard character, or a legacy duplicate row, can't flip which row
    // this booking is matched against on different deliveries.
    const escapedEmail = escapeLikePattern(fields.email)
    const { data: existingLeads } = await db
      .from("leads")
      .select("id, status, existing_client_contact_id")
      .ilike("email", escapedEmail)
      .order("created_at", { ascending: true })
      .limit(1)

    const { data: existingContacts } = await db
      .from("contacts")
      .select("id, full_name, portal_tier")
      .ilike("email", escapedEmail)
      .order("created_at", { ascending: true })
      .limit(1)

    // Existing-client tagging (dev job 93580372, closed a gap found in review):
    // computed once here so BOTH the "update an existing lead" branch and the
    // "create a new lead" branch below can use it — a repeat booking from an
    // established client is just as much a booking-with-an-existing-client as
    // a first one is, and must not be silently untaggable just because it
    // happens to match an OLD lead row instead of creating a fresh one.
    let taggedContactId: string | null = null
    if (existingContacts && existingContacts.length > 0) {
      const contact = existingContacts[0] as { id: string; full_name: string; portal_tier: string | null }
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
    // When a made link's row was found, the referrer comes from that row ONLY (decided in Phase 2); the address-based lookup below is skipped.
    if (fields.referralCode && !linkCtx?.row) {
      try {
        const { data: referrer } = await db
          .from("contacts")
          .select("id, full_name")
          .ilike("referral_code", escapeLikePattern(fields.referralCode))
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
    // .select("id") so a booking that needs a look but whose card cannot be saved can still be marked for review on this stored copy.
    const storedEvent = await db.from("webhook_events").insert({
      source: "calendly",
      event_type: payload.event || "unknown",
      external_id: payload.payload?.uri || "unknown",
      payload,
      review_status: "auto_created",
    }).select("id")
    const webhookEventId: string | null = (Array.isArray(storedEvent?.data) ? storedEvent.data[0]?.id : null) ?? null

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

    // ─── Booking links, PHASE 2 (after the paid-call step, which keeps keying on the booker's email and runs first) ───
    // Judges the match, claims a one-time link, and applies the kind's rule: save the call under the contact, or run the lead path below with the link's
    // extras. Anything thrown falls back to today's path and raises a card. It can answer here itself (call saved under the contact / nothing to save).
    let tailHooks: LegacyTailHooks | undefined
    if (linkCtx && linkCtx.lookup !== "no_tag") {
      try {
        const out = await applyBookingLink({ db, payload, fields, ctx: linkCtx, existingLeads, webhookEventId })
        if (out.kind === "handled") return NextResponse.json(out.body)
        // The link table could not be read for a booking that carries our tag: nothing was created; ask Calendly to send it again.
        if (out.kind === "retry") return NextResponse.json({ error: "Booking link lookup failed — please retry", retry: true }, { status: 503 })
        if (out.kind === "legacy") {
          tailHooks = out.hooks
          referrerContactId = out.referrer?.contactId ?? null
          referrerName = out.referrer?.name ?? null
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error("[calendly-webhook] booking-link step failed (booking handled as usual):", message)
        tailHooks = undefined
        if (linkCtx.row) { referrerContactId = null; referrerName = null }
        await raiseCallCheck(
          db,
          { kind: "effect_failed", dedupeKey: linkCtx.tag.inviteeUri ?? linkCtx.tag.eventUri ?? "unknown", bookingLinkId: linkCtx.row?.id ?? null, eventUri: linkCtx.tag.eventUri, payload: { reason: message.slice(0, 200), booker_email: fields.email, booker_name: fields.name } },
          { webhookEventId },
        )
      }
    }

    // Everything from here on (update the lead that already exists, or create a new one, attribute a referral,
    // keep the booking as its own call) lives in lib/calendly/legacy-lead-tail.ts — moved there unchanged.
    const tail = await runLegacyLeadTail({
      db,
      payload,
      fields,
      existingLeads,
      taggedContactId,
      referrerContactId,
      referrerName,
      hooks: tailHooks,
    })
    if (tail.kind === "insert_failed") {
      return NextResponse.json({ error: tail.message }, { status: 500 })
    }
    if (tail.kind === "updated") {
      return NextResponse.json({ lead_id: tail.leadId, action: "updated" })
    }
    return NextResponse.json({
      lead_id: tail.leadId,
      action: "created",
      referrer_contact_id: tail.referrerContactId,
    })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[calendly-webhook] Error:", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
