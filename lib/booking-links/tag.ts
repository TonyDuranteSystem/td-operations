/**
 * Booking links — reading the tag a made link leaves on a Calendly booking.
 *
 * The link redirects to Calendly with utm_term=<id>; Calendly returns it in payload.tracking.utm_term (proven on a real booking, a reschedule and a custom length).
 * This is a NEW reader on purpose: the existing parser (lib/calendly/parse-invitee.ts) never reads utm_term and stays untouched.
 * The tag is an untrusted HINT — a visitor can edit the address — so the caller always checks the booker's email against the row before anything is saved.
 */

import { isStrictLinkId } from "@/lib/booking-links/id"

export interface LinkTag {
  /** the raw utm_term text, if any (kept only to say "not ours" — never stored whole) */
  utmTerm: string | null
  /** the id, ONLY when utm_term has our strict shape */
  linkId: string | null
  /** this booking's own invitee URI (payload.uri) */
  inviteeUri: string | null
  /** this booking's event URI (payload.event) */
  eventUri: string | null
  /** on a reschedule: the invitee URI of the booking that was replaced */
  oldInvitee: string | null
}

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null)

/** `payload` is the whole webhook body ({ event, payload: { ... } }). Never throws. */
export function extractLinkTag(payload: unknown): LinkTag {
  const empty: LinkTag = { utmTerm: null, linkId: null, inviteeUri: null, eventUri: null, oldInvitee: null }
  if (!isRec(payload) || !isRec(payload.payload)) return empty
  const p = payload.payload
  const tracking = isRec(p.tracking) ? p.tracking : null
  const term = tracking ? str(tracking.utm_term) : null
  return {
    utmTerm: term,
    linkId: isStrictLinkId(term) ? term : null,
    inviteeUri: str(p.uri),
    eventUri: str(p.event),
    oldInvitee: str(p.old_invitee),
  }
}
