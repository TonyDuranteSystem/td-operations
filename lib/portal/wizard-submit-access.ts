import type { PortalIdentity } from '@/lib/portal/resolve-portal-identity'
import { hasCapability, type CapabilityFlags } from '@/lib/portal/team/capabilities'

/**
 * Which wizards a TEAM login may use, and under which tick (team rules, 2026-11-17).
 *   - the bank application (Payset / Relay)  -> the "Bank applications" tick
 *   - the company data form (onboarding)     -> the "Company data form" tick
 *   - everything else is refused, whatever ticks the login holds: tax and tax confirmations, ITIN, closing
 *     the company, formation (a new company belongs to the buyer, a person), the TD Communication audit, and
 *     any wizard type not named here (default-deny).
 * Before this, the server refused only the ITIN wizard and checked the company, so a team login with NO ticks
 * could post the tax, closure, banking, onboarding or formation forms straight to the server.
 * PURE — shared by the wizard-submit / wizard-progress routes, the upload routes and the wizard page.
 */
export function teammateMayUseWizard(capabilities: CapabilityFlags | null | undefined, wizardType: string | undefined): boolean {
  switch (wizardType) {
    case 'banking': // the bank picker (it never posts; it leads to Payset / Relay)
    case 'banking_payset':
    case 'banking_relay':
      return hasCapability(capabilities, 'bank_applications')
    case 'onboarding':
      return hasCapability(capabilities, 'company_data_form')
    default:
      return false
  }
}

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
  wizardType?: string,
): boolean {
  if (identity.kind === 'contact') {
    // If an account is targeted, the contact must be linked to it.
    if (accountId && !identity.accountIds.includes(accountId)) return false
    // If a contact is named in the body, it must be the logged-in contact.
    if (contactId && contactId !== identity.contactId) return false
    return true
  }
  if (identity.kind === 'teammate') {
    // Only the wizards a tick covers (see teammateMayUseWizard) — ITIN, tax, closure, formation and the rest are refused.
    if (!teammateMayUseWizard(identity.capabilities, wizardType)) return false
    // A team login is always tied to ITS company: a missing company is refused too (it used to pass, which let it
    // reach contact-scoped drafts that carry no company, e.g. an owner's ITIN draft), and so is any other company.
    if (!accountId || accountId !== identity.accountId) return false
    return true
  }
  // kind === 'none' (no resolvable portal identity) → deny.
  return false
}

/**
 * When a draft (wizard_progress row) is UPDATED by id: the form type the caller names must be the type the draft really is.
 * A team login holds a tick for ONE kind of form, so naming a different type than the saved one would let it write into
 * another form's draft in its own company. Other logins are unaffected (they own every form of their own).
 */
export function savedDraftTypeAllowed(identity: PortalIdentity, savedType: string | null | undefined, namedType: string | undefined): boolean {
  if (identity.kind !== 'teammate') return true
  return !!savedType && savedType === namedType
}
