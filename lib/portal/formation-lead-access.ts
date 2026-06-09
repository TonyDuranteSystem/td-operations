/**
 * Formation lead ownership — does a given new-company formation lead belong to
 * the logged-in person?
 *
 * A formation offer carries `lead_id` (the new company) + either `contact_id`
 * (the existing person, set by the auto-anchor path) and/or `client_email` (the
 * recipient). The wizard PAGE (`app/portal/wizard/page.tsx`) gates `?lead=` by
 * matching the logged-in person's email against the formation offer's
 * client_email. The wizard SUBMIT route must re-prove the same thing so a member
 * can't tamper a lead_id and submit a formation tied to someone else's lead.
 * dev_task b41cc66f.
 *
 * Pure decision (no DB) so every case is unit-testable. The route fetches the
 * latest offer for the lead and the logged-in person's emails, then calls this.
 */

export interface LeadOwnershipOffer {
  client_email: string | null
  contract_type: string | null
  contact_id: string | null
}

/**
 * True iff the latest offer for the lead proves ownership: it is a formation
 * offer AND (its contact_id is the logged-in contact OR its client_email is one
 * of the logged-in person's emails). Mirrors the page gate, plus the contact_id
 * path for offers created via the auto-anchor (which set contact_id).
 */
export function formationLeadOwned(
  offer: LeadOwnershipOffer | null,
  contactId: string | null,
  ownerEmails: ReadonlySet<string>,
): boolean {
  if (!offer || offer.contract_type !== 'formation') return false
  if (offer.contact_id && contactId && offer.contact_id === contactId) return true
  if (offer.client_email && ownerEmails.has(offer.client_email.toLowerCase())) return true
  return false
}
