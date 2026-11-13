/**
 * Booking links — reading and updating the link rows (table booking_links). The client is passed in (the webhook's own service client, or a fake in a test).
 * New table, so it is reached through an untyped client like lead_calls. Every function:
 *   - checks `error` (a database error is never read as "no such link"),
 *   - treats a missing table as "nothing here" (a deploy ahead of the migration changes nothing),
 *   - and NEVER throws.
 */

import type { LinkRowFacts } from "@/lib/booking-links/match"
import { isMissingTable, isUniqueViolation } from "@/lib/booking-links/missing-table"

export interface BookingLinkRow extends LinkRowFacts {
  id: string
  public_id: string
  kind_label: string
  rule_snapshot: unknown
  contact_id: string | null
  account_id: string | null
  lead_id: string | null
  person_name: string | null
  person_language: string | null
  claimed_event_uri: string | null
  referrer_contact_id: string | null
  referrer_code: string | null
  referral_outcome: string | null
}

const COLUMNS =
  "id, public_id, kind_label, rule_snapshot, status, once, revoked_at, expires_at, claimed_invitee_uri, claimed_event_uri, claimed_email, effects_done_at, person_emails, " +
  "contact_id, account_id, lead_id, person_name, person_language, referrer_contact_id, referrer_code, referral_outcome"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- booking_links is not in the generated database types until the production migration is applied
type Db = any

export type LookupResult =
  | { state: "found"; row: BookingLinkRow }
  | { state: "none" }
  | { state: "error"; message: string }

function norm(row: unknown): BookingLinkRow {
  const r = row as BookingLinkRow
  return { ...r, person_emails: Array.isArray(r.person_emails) ? r.person_emails : [] }
}

/** Exact match on the public id (the caller has already checked the strict shape). */
export async function findLinkByPublicId(db: Db, publicId: string): Promise<LookupResult> {
  try {
    const { data, error } = await db.from("booking_links").select(COLUMNS).eq("public_id", publicId).maybeSingle()
    if (error) return isMissingTable(error) ? { state: "none" } : { state: "error", message: String(error.message ?? "lookup failed") }
    return data ? { state: "found", row: norm(data) } : { state: "none" }
  } catch (e) {
    return { state: "error", message: e instanceof Error ? e.message : String(e) }
  }
}

/** A booking that names the booking it replaced (a reschedule) can be found through that old booking even when the tag did not arrive. */
export async function findLinkByClaimedInvitee(db: Db, inviteeUri: string): Promise<LookupResult> {
  try {
    const { data, error } = await db.from("booking_links").select(COLUMNS).eq("claimed_invitee_uri", inviteeUri).maybeSingle()
    if (error) return isMissingTable(error) ? { state: "none" } : { state: "error", message: String(error.message ?? "lookup failed") }
    return data ? { state: "found", row: norm(data) } : { state: "none" }
  } catch (e) {
    return { state: "error", message: e instanceof Error ? e.message : String(e) }
  }
}

export type ClaimResult = { state: "claimed" } | { state: "lost" } | { state: "duplicate" } | { state: "error"; message: string }

/**
 * The atomic claim: ONE statement that closes the link and records who took it, only while it is still open and not revoked.
 * `lost` = no row changed (someone else got there first, or it was revoked) — the caller reads the row again and decides again.
 * `duplicate` = this same booking already holds another link (the unique index on claimed_invitee_uri) — an explicit branch, not a failure.
 */
export async function claimLink(db: Db, linkId: string, c: { inviteeUri: string; eventUri: string | null; email: string; now: Date }): Promise<ClaimResult> {
  try {
    const { data, error } = await db
      .from("booking_links")
      .update({ status: "claimed", claimed_invitee_uri: c.inviteeUri, claimed_event_uri: c.eventUri, claimed_email: c.email, claimed_at: c.now.toISOString(), updated_at: c.now.toISOString() })
      .eq("id", linkId)
      .eq("status", "open")
      .is("revoked_at", null)
      .select("id")
    if (error) return isUniqueViolation(error) ? { state: "duplicate" } : { state: "error", message: String(error.message ?? "claim failed") }
    return Array.isArray(data) && data.length > 0 ? { state: "claimed" } : { state: "lost" }
  } catch (e) {
    return { state: "error", message: e instanceof Error ? e.message : String(e) }
  }
}

/** A reschedule: the claim moves from the old booking to the new one, only while it still names the old one. true = moved. */
export async function moveClaim(db: Db, linkId: string, m: { oldInvitee: string; inviteeUri: string; eventUri: string | null; now: Date }): Promise<boolean> {
  try {
    const { data, error } = await db
      .from("booking_links")
      .update({ claimed_invitee_uri: m.inviteeUri, claimed_event_uri: m.eventUri, effects_done_at: null, updated_at: m.now.toISOString() })
      .eq("id", linkId)
      .eq("claimed_invitee_uri", m.oldInvitee)
      .select("id")
    return !error && Array.isArray(data) && data.length > 0
  } catch {
    return false
  }
}

/** Set only after the kind's effect really happened. A replay re-runs the effects until this is set. */
export async function markEffectsDone(db: Db, linkId: string, now: Date): Promise<boolean> {
  try {
    const { error } = await db.from("booking_links").update({ effects_done_at: now.toISOString(), updated_at: now.toISOString() }).eq("id", linkId)
    return !error
  } catch {
    return false
  }
}

/** Remember which lead this booking made or updated (only if the row has none yet). Best effort. */
export async function setLeadIfEmpty(db: Db, linkId: string, leadId: string, now: Date): Promise<void> {
  try {
    await db.from("booking_links").update({ lead_id: leadId, updated_at: now.toISOString() }).eq("id", linkId).is("lead_id", null)
  } catch {
    /* informational */
  }
}

export async function setReferralOutcome(db: Db, linkId: string, outcome: string, now: Date): Promise<void> {
  try {
    await db.from("booking_links").update({ referral_outcome: outcome, updated_at: now.toISOString() }).eq("id", linkId)
  } catch {
    /* informational */
  }
}
