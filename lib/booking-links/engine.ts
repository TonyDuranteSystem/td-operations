/**
 * Booking links — the two phases the Calendly webhook runs for a booking that carries (or may carry) a made link's tag.
 *
 *   PHASE 1  resolveLinkPhase1   read-only, right after the booking is parsed: read the tag, find the link row (by the id, or — when the tag did not arrive on a
 *                                reschedule — by the old booking it replaces). Never throws; a database error is reported, never read as "no such link".
 *   PHASE 2  applyBookingLink    after the paid-call step (which keeps keying on the BOOKER's email and runs first): judge the match (match.ts), claim a one-time link
 *                                atomically, then apply the kind's rule pinned on the row: attach the call under the contact | create/update the lead as today | save nothing.
 *
 * Fail-open by design: anything that is not a clean match — unknown id, used or revoked link, wrong email, a thrown error — falls back to TODAY's behaviour (the lead
 * path) and raises a card for a human; the webhook never drops a booking and this code adds no new way for the route to answer 500.
 * A replay of a claimed link re-runs the effects until they are marked done, and never reaches the legacy path by itself (a re-delivery cannot make a stray lead).
 */

import type { ParsedInvitee } from "@/lib/calendly/parse-invitee"
import type { ExistingLeadRow, LegacyTailHooks } from "@/lib/calendly/legacy-lead-tail"
import { isEstablishedClientContact } from "@/lib/calendly/existing-client-tag"
import { recordContactBooking } from "@/lib/leads/contact-calls"
import { findContactByAnyEmail, type AliasContact } from "@/lib/operations/contact-email-aliases"
import { parseRuleSnapshot, type RuleSnapshot } from "@/lib/booking/kinds"
import { recorderFor, type PersonState } from "@/lib/booking/plan"
import { extractLinkTag, type LinkTag } from "@/lib/booking-links/tag"
import { decideLinkMatch, normalizeEmail } from "@/lib/booking-links/match"
import { claimLink, findLinkByClaimedInvitee, findLinkByPublicId, markEffectsDone, moveClaim, setLeadIfEmpty, setReferralOutcome, type BookingLinkRow } from "@/lib/booking-links/store"
import { clip, raiseCallCheck, REVIEW_STATUS_LINK_CHECK, type CallCheckFallback, type CallCheckKind } from "@/lib/booking-links/call-checks"
import { decideReferralCredit } from "@/lib/booking-links/referral"
import { normalizeLeadLanguage } from "@/lib/booking-links/language"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the webhook's own service client; new tables are untyped until the production migration
type Db = any

// ─── Phase 1 ────────────────────────────────────────────────

export interface LinkContext {
  tag: LinkTag
  lookup: "no_tag" | "none" | "found" | "error"
  row: BookingLinkRow | null
  foundBy: "public_id" | "old_invitee" | null
  errorMessage?: string
}

export async function resolveLinkPhase1(db: Db, payload: unknown): Promise<LinkContext> {
  const tag = extractLinkTag(payload)
  try {
    if (tag.linkId) {
      const r = await findLinkByPublicId(db, tag.linkId)
      if (r.state === "found") return { tag, lookup: "found", row: r.row, foundBy: "public_id" }
      if (r.state === "error") return { tag, lookup: "error", row: null, foundBy: null, errorMessage: r.message }
      // an id of our shape that matches no link: fall through to the reschedule defence, then report it as unknown
    }
    if (tag.oldInvitee) {
      const r = await findLinkByClaimedInvitee(db, tag.oldInvitee)
      if (r.state === "found") return { tag, lookup: "found", row: r.row, foundBy: "old_invitee" }
      if (r.state === "error") return { tag, lookup: "error", row: null, foundBy: null, errorMessage: r.message }
    }
    return { tag, lookup: tag.linkId ? "none" : "no_tag", row: null, foundBy: null }
  } catch (err) {
    return { tag, lookup: "error", row: null, foundBy: null, errorMessage: err instanceof Error ? err.message : String(err) }
  }
}

// ─── Phase 2 ────────────────────────────────────────────────

export interface Phase2Input {
  db: Db
  payload: Record<string, unknown>
  fields: ParsedInvitee
  ctx: LinkContext
  existingLeads: ExistingLeadRow[] | null
  /** the stored copy of this delivery in webhook_events, so a card that cannot be saved still leaves a mark there */
  webhookEventId: string | null
  now?: Date
}

export type Phase2Outcome =
  | { kind: "passthrough" }
  | { kind: "handled"; body: Record<string, unknown> }
  /** the link table could not be read for a booking carrying OUR tag: the route answers 503 so Calendly sends the booking again (nothing is created meanwhile) */
  | { kind: "retry"; message: string }
  | { kind: "legacy"; referrer: { contactId: string; name: string | null } | null; hooks: LegacyTailHooks }

const LEGACY_NO_REFERRER: Phase2Outcome = { kind: "legacy", referrer: null, hooks: {} }

function scheduledStartOf(payload: Record<string, unknown>): string | null {
  const p = (payload.payload as Record<string, unknown>) || {}
  const scheduled = p.scheduled_event as Record<string, unknown> | undefined
  return (scheduled?.start_time as string) || null
}

interface Signals { established: boolean | null }

/** The same signals today's webhook uses to call a contact an established client (a portal tier past "lead", a linked company, or a service). null = a read failed. */
async function establishedSignals(db: Db, contact: Pick<AliasContact, "id" | "portal_tier">): Promise<Signals> {
  try {
    const [acc, sd] = await Promise.all([
      db.from("account_contacts").select("account_id").eq("contact_id", contact.id).limit(1),
      db.from("service_deliveries").select("id").eq("contact_id", contact.id).limit(1),
    ])
    if (acc.error || sd.error) return { established: null }
    return { established: isEstablishedClientContact({ portal_tier: contact.portal_tier, hasAccountLink: (acc.data?.length ?? 0) > 0, hasServiceDelivery: (sd.data?.length ?? 0) > 0 }) }
  } catch {
    return { established: null }
  }
}

type Person =
  | { state: "contact"; contact: Pick<AliasContact, "id" | "full_name" | "portal_tier">; accountId: string | null; established: boolean | null }
  | { state: "lead" | "new"; established: boolean | null }
  | { state: "error"; message: string }

/**
 * Who is the booker? A contact the link was MADE FOR (row.contact_id) is a contact, full stop — Antonio picked them. Otherwise the booker's email is looked
 * up alias-aware (email, email_2, alternate emails): only an ESTABLISHED client counts as a contact (a bare stub row is not a client), the same bar as today's tagging.
 */
async function resolvePerson(db: Db, row: BookingLinkRow, email: string, existingLeads: ExistingLeadRow[] | null): Promise<Person> {
  if (row.contact_id) {
    try {
      const { data, error } = await db.from("contacts").select("id, full_name, portal_tier").eq("id", row.contact_id).maybeSingle()
      if (error) return { state: "error", message: String(error.message ?? "contact lookup failed") }
      if (data) {
        const sig = await establishedSignals(db, data)
        return { state: "contact", contact: data, accountId: row.account_id, established: sig.established }
      }
    } catch (err) {
      return { state: "error", message: err instanceof Error ? err.message : String(err) }
    }
  }
  const found = await findContactByAnyEmail(db, email)
  if (found.state === "error") return { state: "error", message: found.message }
  if (found.state === "found") {
    const sig = await establishedSignals(db, found.contact)
    if (sig.established === true) return { state: "contact", contact: found.contact, accountId: row.account_id, established: true }
    // a stub row is not a client: the booker is a lead / new person exactly as today
    return { state: existingLeads && existingLeads.length > 0 ? "lead" : "new", established: sig.established }
  }
  return { state: existingLeads && existingLeads.length > 0 ? "lead" : "new", established: false }
}

export async function applyBookingLink(input: Phase2Input): Promise<Phase2Outcome> {
  const { db, fields, ctx } = input
  const now = input.now ?? new Date()
  const tag = ctx.tag
  const fallback: CallCheckFallback = { webhookEventId: input.webhookEventId }
  const dedupeKey = tag.inviteeUri ?? tag.eventUri ?? `term:${clip(tag.utmTerm, 40) ?? ""}`

  const card = (kind: CallCheckKind, row: BookingLinkRow | null, payloadExtra: Record<string, unknown>) =>
    raiseCallCheck(
      db,
      {
        kind,
        dedupeKey,
        bookingLinkId: row?.id ?? null,
        contactId: row?.contact_id ?? null,
        eventUri: tag.eventUri,
        payload: { booker_email: fields.email, booker_name: fields.name, kind_label: row?.kind_label ?? null, person_name: row?.person_name ?? null, ...payloadExtra },
      },
      fallback,
    )

  if (ctx.lookup === "no_tag") return { kind: "passthrough" }

  if (ctx.lookup === "error") {
    // A booking that carries OUR tag (the strict 22-character id) is one Antonio made a link for: reading the link failed, so we cannot tell what it should do.
    // Falling through to today's lead path would quietly make a stray lead for a client's call. Answer "try again" instead — Calendly re-sends it. Paid-call step has
    // already run (idempotent on the charge), so a retry cannot double the money. Anything WITHOUT our tag (untagged, an ad keyword, a reschedule found only by its old booking) stays fail-open.
    const strict = !!tag.linkId
    try {
      const { reportSystemError } = await import("@/lib/system-errors")
      await reportSystemError({
        source: "server",
        route: "/api/webhooks/calendly",
        message: strict
          ? `Booking link lookup failed (booking sent back to Calendly to retry): ${ctx.errorMessage ?? "unknown error"}`
          : `Booking link lookup failed (booking handled as usual): ${ctx.errorMessage ?? "unknown error"}`,
        context: { invitee_uri: tag.inviteeUri },
      })
    } catch { /* best effort */ }
    if (!strict) return { kind: "passthrough" }
    try {
      if (input.webhookEventId) await db.from("webhook_events").update({ review_status: REVIEW_STATUS_LINK_CHECK }).eq("id", input.webhookEventId)
    } catch { /* best effort: the system error above is the primary trail */ }
    return { kind: "retry", message: clip(ctx.errorMessage, 160) ?? "link lookup failed" }
  }

  if (ctx.lookup === "none" || !ctx.row) {
    if (tag.linkId) await card("unknown_id", null, { reason: "not_found", term: clip(tag.utmTerm, 40) })
    return { kind: "passthrough" }
  }

  let row: BookingLinkRow = ctx.row
  const snapshot: RuleSnapshot | null = parseRuleSnapshot(row.rule_snapshot)
  if (!snapshot) {
    await card("effect_failed", row, { reason: "The link's rule could not be read." })
    return LEGACY_NO_REFERRER
  }

  const judge = () => decideLinkMatch({ row, inviteeUri: tag.inviteeUri, oldInvitee: tag.oldInvitee, bookerEmail: fields.email, now })
  let decision = judge()
  let claimedNow = false

  // A one-time link is closed by ONE atomic update. If another delivery wins the race, the row is read again and judged again (usually: replay).
  for (let attempt = 0; attempt < 2 && decision.action === "claim"; attempt++) {
    if (!tag.inviteeUri) {
      await card("effect_failed", row, { reason: "The booking carried no invitee address, so the link could not be claimed." })
      return LEGACY_NO_REFERRER
    }
    const claim = await claimLink(db, row.id, { inviteeUri: tag.inviteeUri, eventUri: tag.eventUri, email: fields.email.trim().toLowerCase(), now })
    if (claim.state === "claimed") {
      claimedNow = true
      break
    }
    if (claim.state === "duplicate") {
      await card("unknown_id", row, { reason: "booking_already_linked" })
      return LEGACY_NO_REFERRER
    }
    if (claim.state === "error") {
      await card("effect_failed", row, { reason: `The link could not be claimed: ${clip(claim.message, 160)}` })
      return LEGACY_NO_REFERRER
    }
    const again = await findLinkByPublicId(db, row.public_id)
    if (again.state !== "found") {
      await card("effect_failed", row, { reason: "The link could not be read again after a lost claim." })
      return LEGACY_NO_REFERRER
    }
    row = again.row
    decision = judge()
  }

  switch (decision.action) {
    case "unknown":
      return { kind: "passthrough" }
    case "inactive":
      await card("unknown_id", row, { reason: decision.reason })
      return LEGACY_NO_REFERRER
    case "used":
      await card("unknown_id", row, { reason: "used" })
      return LEGACY_NO_REFERRER
    case "mismatch":
      // wrong email on a made link: nothing is claimed, no credit, the booking is a normal lead as today and a card asks Antonio
      await card("mismatch", row, {})
      return LEGACY_NO_REFERRER
    case "claim":
      if (!claimedNow) {
        // still "claim" after two tries: the claim keeps being lost to something that is not a replay
        await card("effect_failed", row, { reason: "The link could not be claimed (it kept changing under us)." })
        return LEGACY_NO_REFERRER
      }
      break
    case "replay":
      if (decision.effectsDone) return { kind: "handled", body: { action: "replay" } }
      break
    case "reschedule": {
      const moved = tag.inviteeUri && tag.oldInvitee ? await moveClaim(db, row.id, { oldInvitee: tag.oldInvitee, inviteeUri: tag.inviteeUri, eventUri: tag.eventUri, now }) : false
      if (!moved) {
        await card("unknown_id", row, { reason: "used" })
        return LEGACY_NO_REFERRER
      }
      break
    }
    case "reusable":
    default:
      break
  }

  return runEffects({ ...input, now }, row, snapshot, card)
}

type CardFn = (kind: CallCheckKind, row: BookingLinkRow | null, extra: Record<string, unknown>) => Promise<unknown>

async function runEffects(input: Phase2Input & { now: Date }, row: BookingLinkRow, snapshot: RuleSnapshot, card: CardFn): Promise<Phase2Outcome> {
  const { db, payload, fields, existingLeads, now, ctx } = input
  const rule = snapshot.rule

  const person = await resolvePerson(db, row, fields.email, existingLeads)
  if (person.state === "error") {
    await card("effect_failed", row, { reason: `Could not look the person up: ${clip(person.message, 160)}` })
    return LEGACY_NO_REFERRER
  }
  const state: PersonState = person.state
  const recorder = recorderFor(rule, state)
  const done = async () => {
    if (row.once) await markEffectsDone(db, row.id, now)
  }

  if (recorder === "none") {
    await done()
    return { kind: "handled", body: { action: "calendar_only" } }
  }

  if (recorder === "attach" && person.state === "contact") {
    const res = await recordContactBooking(db, {
      contactId: person.contact.id,
      accountId: person.accountId,
      linkId: row.id,
      bookedAt: now.toISOString(),
      scheduledStart: scheduledStartOf(payload),
      eventUri: fields.eventUri,
      eventTypeName: fields.eventTypeName,
      oldInvitee: ctx.tag.oldInvitee,
    })
    if (!res.ok) {
      // the call could not be saved under the contact: the booking still becomes a lead as today (nothing is lost) and a card says why
      await card("effect_failed", row, { reason: `The call could not be saved under the contact: ${clip(res.error, 160)}` })
      return LEGACY_NO_REFERRER
    }
    await done()
    return { kind: "handled", body: { action: "attached", contact_id: person.contact.id, call_id: res.callId } }
  }

  // recorder === "lead": today's lead path, with the link's extras
  const createsLead = !existingLeads || existingLeads.length === 0
  let referrer: { contactId: string; name: string | null } | null = null
  if (row.referrer_contact_id) {
    const verdict = decideReferralCredit({
      hasReferrer: true,
      mismatch: false,
      linkOneTime: row.once,
      emailChecked: row.person_emails.some((e) => normalizeEmail(e) !== ""),
      createdNewLead: createsLead,
      bookerEstablished: person.established,
    })
    if (verdict.credit) {
      let name: string | null = null
      try {
        const { data } = await db.from("contacts").select("full_name").eq("id", row.referrer_contact_id).maybeSingle()
        name = (data?.full_name as string | null) ?? null
      } catch { /* the lead is made either way; the name is only a label */ }
      referrer = { contactId: row.referrer_contact_id, name }
    } else if ("outcome" in verdict && !row.referral_outcome) {
      await setReferralOutcome(db, row.id, verdict.outcome, now)
    }
  }

  const hooks: LegacyTailHooks = {
    notesPrefix: rule.mark_lead && createsLead ? `Booking kind: ${snapshot.kind_label}` : null,
    languageFallback: normalizeLeadLanguage(row.person_language),
    onLeadResolved: async (leadId) => {
      await setLeadIfEmpty(db, row.id, leadId, now)
      await done()
    },
    onReferral: async (outcome) => {
      if (!row.referral_outcome) await setReferralOutcome(db, row.id, outcome, now)
    },
  }
  return { kind: "legacy", referrer, hooks }
}
