/**
 * Booking links — what to do when a booking arrives carrying a link's tag. PURE: the caller reads the row and passes the facts; nothing here touches
 * the database, the clock (`now` is a parameter) or the network.
 *
 * The decision, in the order it is made:
 *   unknown      a tag in our strict shape but no such link                       -> card, today's behaviour
 *   replay       this very booking was already claimed (Calendly re-sent it)      -> re-run the effects until they are marked done; NEVER the legacy path
 *   inactive     the link was revoked / has expired                                -> card, today's behaviour
 *   mismatch     the booker's email is not one of the person's emails             -> NO claim, card, today's behaviour, no referral credit
 *   reschedule   a NEW booking that replaces the claimed one (old invitee named)  -> move the claim to the new booking, move the old call
 *   used         a one-time link that another booking already took                -> card, today's behaviour
 *   reusable     a standard 30-minute link (once = false)                          -> NEVER claims; effects only (downstream event-uri uniques stop doubles)
 *   claim        a one-time, open link                                             -> atomic claim (the store does it), then effects
 */

export interface LinkRowFacts {
  status: string
  once: boolean
  revoked_at: string | null
  expires_at: string | null
  claimed_invitee_uri: string | null
  claimed_email: string | null
  effects_done_at: string | null
  /** the person's emails, snapshotted when the link was made; may be empty (the first booker then claims) */
  person_emails: readonly string[]
}

export type LinkDecision =
  | { action: "unknown" }
  | { action: "replay"; effectsDone: boolean }
  | { action: "inactive"; reason: "revoked" | "expired" }
  | { action: "mismatch" }
  | { action: "reschedule" }
  | { action: "used" }
  | { action: "reusable" }
  | { action: "claim" }

export function normalizeEmail(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toLowerCase() : ""
}

/** true = the booker is one of the row's emails; null = the row has no emails to compare (the test is skipped). */
export function bookerMatchesRow(personEmails: readonly string[], bookerEmail: string): boolean | null {
  const list = personEmails.map(normalizeEmail).filter(Boolean)
  if (list.length === 0) return null
  const booker = normalizeEmail(bookerEmail)
  return booker !== "" && list.includes(booker)
}

export interface LinkMatchInput {
  row: LinkRowFacts | null
  /** this booking's invitee URI */
  inviteeUri: string | null
  /** on a reschedule: the invitee URI of the booking it replaces */
  oldInvitee: string | null
  bookerEmail: string
  now: Date
}

export function decideLinkMatch(input: LinkMatchInput): LinkDecision {
  const { row, inviteeUri, oldInvitee, bookerEmail, now } = input
  if (!row) return { action: "unknown" }

  // The same booking again (Calendly retries a delivery that got no answer, or a function died half-way): never a "used" link, never the legacy path.
  if (row.once && inviteeUri && row.claimed_invitee_uri === inviteeUri) return { action: "replay", effectsDone: row.effects_done_at !== null }

  if (row.revoked_at) return { action: "inactive", reason: "revoked" }
  if (row.expires_at && new Date(row.expires_at).getTime() <= now.getTime()) return { action: "inactive", reason: "expired" }

  if (row.once && row.status === "claimed") {
    // A reschedule re-fires the booking with a NEW invitee URI and names the old one. It is the same person: the email must still fit.
    if (oldInvitee && row.claimed_invitee_uri === oldInvitee) {
      const sameAsClaim = row.claimed_email ? normalizeEmail(row.claimed_email) === normalizeEmail(bookerEmail) : null
      const sameAsPerson = bookerMatchesRow(row.person_emails, bookerEmail)
      if (sameAsClaim === false || sameAsPerson === false) return { action: "used" }
      return { action: "reschedule" }
    }
    return { action: "used" }
  }

  if (bookerMatchesRow(row.person_emails, bookerEmail) === false) return { action: "mismatch" }

  return row.once ? { action: "claim" } : { action: "reusable" }
}
