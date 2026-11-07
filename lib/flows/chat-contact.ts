/**
 * Which person a staff message in a job's workspace chat is addressed to (Company Closure Part C, dev job a6bbea09).
 *
 * The message is stamped with ONE contact — that is the person who gets the bell and the e-mail, and whose contact thread it
 * lands in. It used to be "the first person linked to the company", which on a company with several members is whoever the
 * database returned first, not the person who bought the service and filled in the wizard (live finding: the closure of a
 * two-member company, bought by member A, was addressed to member B).
 *
 * Order: the job's own contact (the buyer) when that person is still linked to the company → the company's primary member
 * → the first still-linked member → the job's contact even when not linked (a job with no company yet) → nobody.
 * Pure, so the route and the tests use the same rule.
 */

export interface ChatContactLink {
  contact_id: string | null
  is_primary?: boolean | null
  /** set when the person left the company; they are not addressed while another member is linked */
  ended_at?: string | null
}

export function pickChatContact(p: { jobContactId: string | null | undefined; links: readonly ChatContactLink[] }): string | null {
  const jobContact = p.jobContactId ?? null
  const live = p.links.filter((l) => !!l.contact_id && !l.ended_at)
  if (jobContact && live.some((l) => l.contact_id === jobContact)) return jobContact
  const primary = live.find((l) => l.is_primary)
  if (primary?.contact_id) return primary.contact_id
  if (live[0]?.contact_id) return live[0].contact_id
  // every member has left (or none is linked): a contact-scoped job still has its own person
  if (jobContact) return jobContact
  return p.links.find((l) => !!l.contact_id)?.contact_id ?? null
}
