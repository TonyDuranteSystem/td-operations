/**
 * Booking links — may the referrer on a made link be credited for this booking? PURE.
 *
 * "Credit" here means the pending referral attribution the Calendly webhook already makes (createPendingReferral); real commission is decided later, at payment.
 * The referrer comes from the link ROW only (never from a tag in the address). It is attributed only when ALL are true:
 *   - the row names a referrer,
 *   - the email on the booking matched the link's person (a wrong-email booking is a normal lead and NEVER earns a credit — a card asks instead),
 *   - THIS booking creates a brand-new lead (an existing lead / an established client is not a new person),
 *   - the booker is not an established client (alias-aware: email, email_2, alternate emails); if that could not be checked, no credit (fail closed).
 * Whatever is decided is written on the row (`referral_outcome`) so a credit that did not happen is never silent.
 */

export interface ReferralFacts {
  hasReferrer: boolean
  mismatch: boolean
  createdNewLead: boolean
  /** true / false, or null when it could not be checked (a read failed) */
  bookerEstablished: boolean | null
}

export type ReferralOutcome = "no_referrer" | "mismatch" | "not_new_lead" | "booker_is_client" | "booker_unchecked"
export type ReferralDecision = { credit: true } | { credit: false; outcome: ReferralOutcome }

export function decideReferralCredit(f: ReferralFacts): ReferralDecision {
  if (!f.hasReferrer) return { credit: false, outcome: "no_referrer" }
  if (f.mismatch) return { credit: false, outcome: "mismatch" }
  if (!f.createdNewLead) return { credit: false, outcome: "not_new_lead" }
  if (f.bookerEstablished === null) return { credit: false, outcome: "booker_unchecked" }
  if (f.bookerEstablished) return { credit: false, outcome: "booker_is_client" }
  return { credit: true }
}
