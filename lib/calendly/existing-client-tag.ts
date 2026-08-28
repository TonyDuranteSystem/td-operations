/**
 * Decides whether a `contacts` row matched by a Calendly booking's email
 * represents a genuinely established client relationship — used to tag a
 * newly created lead's `existing_client_contact_id` at creation time so it
 * is never treated as an open sales opportunity (see diagnose-contact /
 * diagnose-account's "Lead status" check). Deliberately a SEPARATE column
 * from `converted_to_contact_id`, which several other flows (activation,
 * formation, tax-return intake) read as "the lead that actually converted
 * into this contact" — reusing it here would let a throwaway booking lead
 * masquerade as someone's real conversion record.
 *
 * Deliberately an ALLOWLIST, not a `!== 'lead'` denylist: `portal_tier` is
 * nullable and reachable as null on real contact rows (e.g. contact-only
 * ITIN clients, who have no linked account so nothing ever computes their
 * tier). A denylist would misfire on null exactly like it would on a real
 * active client. `hasAccountLink`/`hasServiceDelivery` catch the contacts
 * whose `portal_tier` is null or stale for reasons unrelated to whether they
 * are a real client (co-members inherit tier from the account; contact-only
 * clients never get one at all).
 */

const ESTABLISHED_PORTAL_TIERS = ["formation", "onboarding", "active"] as const

export interface ExistingContactSignals {
  portal_tier: string | null
  hasAccountLink: boolean
  hasServiceDelivery: boolean
}

export function isEstablishedClientContact(signals: ExistingContactSignals): boolean {
  if (
    signals.portal_tier &&
    (ESTABLISHED_PORTAL_TIERS as readonly string[]).includes(signals.portal_tier)
  ) {
    return true
  }
  return signals.hasAccountLink || signals.hasServiceDelivery
}
