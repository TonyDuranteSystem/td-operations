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

/** Shared ownership check, parameterized by the expected contract_type — see
 * formationLeadOwned and onboardingLeadOwned below for the public entry points.
 * Kept internal (not exported) so each contract type still has its own named,
 * independently-testable function rather than a stringly-typed call site. */
function leadOwnedForContractType(
  offer: LeadOwnershipOffer | null,
  expectedContractType: string,
  contactId: string | null,
  ownerEmails: ReadonlySet<string>,
): boolean {
  if (!offer || offer.contract_type !== expectedContractType) return false
  if (offer.contact_id && contactId && offer.contact_id === contactId) return true
  if (offer.client_email && ownerEmails.has(offer.client_email.toLowerCase())) return true
  return false
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
  return leadOwnedForContractType(offer, 'formation', contactId, ownerEmails)
}

/**
 * Same proof, for an onboarding offer — a client's FIRST company via onboarding
 * always starts as a lead, so this covers that case (dev job bc2a8f7f,
 * 2026-09-20). A returning client's SECOND+ onboarding has no lead at all —
 * see onboardingOfferOwned below, the real anchor for that case (2026-09-21,
 * corrected directly by Antonio after this lead-only version shipped without
 * covering it).
 */
export function onboardingLeadOwned(
  offer: LeadOwnershipOffer | null,
  contactId: string | null,
  ownerEmails: ReadonlySet<string>,
): boolean {
  return leadOwnedForContractType(offer, 'onboarding', contactId, ownerEmails)
}

/**
 * Ownership proof for an onboarding offer found by its OWN id, not a lead —
 * the real, only anchor for a returning client's second+ company (dev job
 * bc2a8f7f, 2026-09-21): staff creates that offer directly on the client's
 * contact record, confirmed live against production and directly by
 * Antonio. The check itself is identical to onboardingLeadOwned/
 * formationLeadOwned — same offer shape, same contact_id/client_email
 * ownership proof — the only difference is how the caller found the offer
 * row (by id here, instead of by lead_id). Re-proven server-side for the
 * same reason as the others: a member could otherwise tamper an offer id
 * and submit data tied to someone else's company.
 */
export function onboardingOfferOwned(
  offer: LeadOwnershipOffer | null,
  contactId: string | null,
  ownerEmails: ReadonlySet<string>,
): boolean {
  return leadOwnedForContractType(offer, 'onboarding', contactId, ownerEmails)
}
