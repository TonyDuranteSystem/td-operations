/**
 * The "legacy lead tail" of the Calendly webhook: what happens to a booking AFTER the paid-call step —
 * update the lead that already exists, or create a new lead (tagged to an established client when the email matches
 * one), attribute a referral, and keep the booking as its own call on the lead.
 *
 * This code used to live inline in app/api/webhooks/calendly/route.ts. It was MOVED here (Booking page, Stage 1a)
 * so the booking-link engine can reach "the lead that this booking created" without editing the route's own flow.
 * The move changes no behaviour: every query, write, log line and answer is the same as before. That is proven by the
 * replay test (tests/unit/calendly-webhook-replay.test.ts), which runs ~100 stored real bookings through the old and
 * the new code and requires identical results. Do not change the logic in here without re-running that replay.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { buildLeadNotes, type ParsedInvitee } from "@/lib/calendly/parse-invitee"
import { createPendingReferral } from "@/lib/operations/referral"
import { notifyReferrerLinked } from "@/lib/operations/referral-notify"
import { recordBooking } from "@/lib/leads/lead-calls"

export interface ExistingLeadRow {
  id: string
  status: string
  existing_client_contact_id?: string | null
}

export interface LegacyTailInput {
  db: SupabaseClient
  /** the whole Calendly payload, as parsed from the request body */
  payload: Record<string, unknown>
  fields: ParsedInvitee
  /** result of the "is there already a lead with this email" lookup (oldest first) */
  existingLeads: ExistingLeadRow[] | null
  /** the established-client contact this booking's email matched, or null */
  taggedContactId: string | null
  /** set only from a verified referral code resolving to a real contact */
  referrerContactId: string | null
  referrerName: string | null
}

export type LegacyTailResult =
  | { kind: "updated"; leadId: string }
  | { kind: "created"; leadId: string; referrerContactId: string | null }
  | { kind: "insert_failed"; message: string }

// Every booking is kept as its own call on the lead (lead_calls), so a rebooking never erases the first
// booking. Best-effort by design: a failure here is logged and must never lose the booking itself.
export async function keepBooking(db: SupabaseClient, leadId: string, payload: Record<string, unknown>) {
  try {
    const p = (payload.payload as Record<string, unknown>) || {}
    const scheduled = p.scheduled_event as Record<string, unknown> | undefined
    const res = await recordBooking(db, {
      leadId,
      bookedAt: new Date().toISOString(),
      scheduledStart: (scheduled?.start_time as string) || null,
      eventUri: (p.event as string) || null,
      oldInvitee: p.old_invitee,
    })
    if (!res.ok) console.error("[calendly-webhook] could not record the call:", res.error)
  } catch (err) {
    console.error("[calendly-webhook] could not record the call:", err instanceof Error ? err.message : String(err))
  }
}

export async function runLegacyLeadTail(input: LegacyTailInput): Promise<LegacyTailResult> {
  const { db, payload, fields, existingLeads, taggedContactId, referrerContactId, referrerName } = input

  if (existingLeads && existingLeads.length > 0) {
    const lead = existingLeads[0]
    const earlyStatuses = ["New", "Call Scheduled"]
    const updates: Record<string, unknown> = {
      status: earlyStatuses.includes(lead.status) ? "Call Scheduled" : lead.status,
      updated_at: new Date().toISOString(),
    }
    if (fields.callDate) updates.call_date = fields.callDate
    if (fields.phone && !lead.status) updates.phone = fields.phone
    // A repeat booking from an established client is just as much an
    // existing-client booking as a first one — tag it too if it wasn't
    // already (a lead can predate this feature, or its first booking might
    // not have matched an established contact yet at the time).
    if (taggedContactId && !lead.existing_client_contact_id) {
      updates.existing_client_contact_id = taggedContactId
    }

    await db.from("leads").update(updates).eq("id", lead.id)
    await keepBooking(db, lead.id, payload)

    console.warn(`[calendly-webhook] [legacy] Updated existing lead ${lead.id} — ${fields.name} (${fields.email})`)
    return { kind: "updated", leadId: lead.id }
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
  if (taggedContactId) {
    console.warn(`[calendly-webhook] Existing contact found — creating lead, tagging to contact ${taggedContactId}`)
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
    return { kind: "insert_failed", message: insertErr.message }
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

  await keepBooking(db, newLead.id, payload)

  console.warn(`[calendly-webhook] Created new lead ${newLead.id} — ${fields.name} (${fields.email})`)
  return { kind: "created", leadId: newLead.id, referrerContactId }
}
