/**
 * Circleback call → client linking decision (WS-D, dev job c0a61e44).
 *
 * Pure and unit-tested: the webhook fetches candidates, THIS decides. Rules
 * (architect-approved):
 *  - Attendee emails are normalized (lowercase/trim); entries with no email
 *    (Fireflies/Otter notetakers) are skipped.
 *  - Internal attendees are excluded: anyone on an internal domain (Antonio is
 *    on essentially every call) plus the explicit extras list (non-domain
 *    internals, e.g. the design partner — a contact row carrying an internal
 *    email must never absorb client calls).
 *  - A lead and a contact sharing one email are ONE identity (the same person
 *    pre/post conversion) — link BOTH ids.
 *  - Exactly one distinct client identity → link it. Anything else → link
 *    NOTHING and return a review reason: a call transcript filed on the wrong
 *    client is worse than an unlinked call.
 */

export const INTERNAL_EMAIL_DOMAINS = ["tonydurante.us"] as const

/**
 * Non-domain internal attendees (recorded decision, architect R3-1.3 pattern):
 * people on our side of the table whose email is not on the company domain.
 * Currently the TD Communication design partner. Review when the team changes.
 */
export const INTERNAL_ATTENDEE_EMAILS = ["cristian@sirioos.design"] as const

export interface AttendeeInput {
  email?: string | null
}

export interface LeadCandidate {
  id: string
  email: string
}

export interface ContactCandidate {
  id: string
  email: string
}

export interface LinkDecision {
  lead_id: string | null
  contact_id: string | null
  /** Emails that participated in matching (normalized, external only). */
  client_emails: string[]
  /** Set when linking was refused — human-readable reason for the review marker. */
  review: string | null
}

/** Normalize an email for matching; null when absent/blank. */
export function normalizeAttendeeEmail(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null
  const e = raw.toLowerCase().trim()
  return e.includes("@") ? e : null
}

export function isInternalEmail(email: string): boolean {
  if ((INTERNAL_ATTENDEE_EMAILS as readonly string[]).includes(email)) return true
  const domain = email.split("@")[1] ?? ""
  return (INTERNAL_EMAIL_DOMAINS as readonly string[]).includes(domain)
}

/**
 * Decide the links for a call given its attendees and the candidate rows the
 * webhook fetched for the external attendee emails.
 */
export function decideCallLinks(
  attendees: AttendeeInput[],
  candidates: { leads: LeadCandidate[]; contacts: ContactCandidate[] },
): LinkDecision {
  const externalEmails = Array.from(
    new Set(
      attendees
        .map((a) => normalizeAttendeeEmail(a.email))
        .filter((e): e is string => !!e && !isInternalEmail(e)),
    ),
  )

  const none: LinkDecision = { lead_id: null, contact_id: null, client_emails: externalEmails, review: null }
  if (externalEmails.length === 0) return none

  // Group candidate rows by normalized email → identities. A lead and a
  // contact on the same email are one identity.
  const byEmail = new Map<string, { leadIds: Set<string>; contactIds: Set<string> }>()
  // Defense-in-depth (hunter finding 3): a candidate row counts ONLY when its
  // own email EXACTLY equals an attendee email after normalization. The DB
  // fetch uses ILIKE, whose `_`/`%` metacharacters could otherwise pull a
  // near-collision row (anna_rossi vs anna.rossi) into the bucket.
  const externalSet = new Set(externalEmails)
  const bucket = (email: string) => {
    const key = email.toLowerCase().trim()
    if (!externalSet.has(key)) return null
    let b = byEmail.get(key)
    if (!b) {
      b = { leadIds: new Set(), contactIds: new Set() }
      byEmail.set(key, b)
    }
    return b
  }
  for (const l of candidates.leads) bucket(l.email)?.leadIds.add(l.id)
  for (const c of candidates.contacts) bucket(c.email)?.contactIds.add(c.id)

  const identities = Array.from(byEmail.entries()).filter(
    ([, b]) => b.leadIds.size > 0 || b.contactIds.size > 0,
  )

  if (identities.length === 0) return none

  if (identities.length > 1) {
    return {
      ...none,
      review: `auto-link refused: ${identities.length} distinct client identities matched (${identities.map(([e]) => e).join(", ")}) — link manually`,
    }
  }

  const [email, b] = identities[0]
  // One identity, but duplicate rows behind it (two leads or two contacts on
  // the same email) is itself ambiguous — refuse rather than pick.
  if (b.leadIds.size > 1 || b.contactIds.size > 1) {
    return {
      ...none,
      review: `auto-link refused: ${email} matches ${b.leadIds.size} leads / ${b.contactIds.size} contacts — link manually`,
    }
  }

  return {
    lead_id: b.leadIds.size === 1 ? Array.from(b.leadIds)[0] : null,
    contact_id: b.contactIds.size === 1 ? Array.from(b.contactIds)[0] : null,
    client_emails: externalEmails,
    review: null,
  }
}
