import type { PortalIdentity } from '@/lib/portal/resolve-portal-identity'

/**
 * Whether the logged-in portal identity may submit a wizard for this subject.
 * DEFAULT-DENY.
 *
 * Closes a cross-company WRITE leak: the wizard-submit route trusted the
 * account_id / contact_id in the request body without checking that the
 * logged-in user is actually linked to them. A member of one company could
 * tamper account_id to another company they are not part of and submit wizard
 * data onto it. This mirrors the access checks already on the other portal
 * routes (chat, payment-links, customers). dev_task b41cc66f.
 *
 * Pure function — no DB access — so every wizard scenario is unit-testable.
 * The route resolves the identity (resolvePortalIdentity) and the effective
 * account_id (accountIdForWizardSubmission already nulls it for formation) and
 * passes them here.
 *
 * NOTE: lead-scoped formation submits also carry a lead_id. The submitting
 * contact_id is still pinned to the logged-in contact here, so a tampered
 * lead_id can only ever attach to the attacker's own contact. A dedicated
 * lead→contact ownership check is a separate follow-up (see dev_task).
 */
export function canSubmitWizard(
  identity: PortalIdentity,
  accountId: string | null,
  contactId: string | null,
): boolean {
  if (identity.kind === 'contact') {
    // If an account is targeted, the contact must be linked to it.
    if (accountId && !identity.accountIds.includes(accountId)) return false
    // If a contact is named in the body, it must be the logged-in contact.
    if (contactId && contactId !== identity.contactId) return false
    return true
  }
  if (identity.kind === 'teammate') {
    // Teammates are scoped to exactly one company.
    if (accountId && accountId !== identity.accountId) return false
    return true
  }
  // kind === 'none' (no resolvable portal identity) → deny.
  return false
}
