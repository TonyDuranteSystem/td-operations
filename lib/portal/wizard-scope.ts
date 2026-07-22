import { isContactScopedWizard, isPersonOwnedWizard } from './wizard-map'

/**
 * Which column the portal wizard page uses to find a client's saved
 * wizard_progress row, plus whether to restrict to rows with no lead_id.
 *
 * `restrictToNoLead` matters only for contact-scoped formation: a contact can
 * have BOTH an original/default formation (lead_id IS NULL) and one or more
 * new-company formations that PR #75 anchors on a lead_id and routes via the
 * ?lead= link. The default (no ?lead=) lookup must select the original, so it
 * excludes lead-anchored rows. See dev_task 21fd1f4a.
 */
export interface WizardProgressScope {
  col: 'lead_id' | 'account_id' | 'contact_id'
  val: string
  restrictToNoLead: boolean
}

/**
 * Resolve where to look for a wizard's saved progress, by precedence:
 *  1. ?lead= new-company formation (PR #75) — keyed on lead_id.
 *  2. Contact-owned wizard (formation) with no lead scope — keyed on
 *     contact_id even when an account exists, so a materialized formation is
 *     found and not re-offered as a duplicate. Restricted to lead_id IS NULL so
 *     a second, lead-anchored company's draft is never picked up here.
 *  3. Account-owned wizards — keyed on account_id.
 *  4. Pre-account fallback — contact_id.
 *
 * Pure function — no DB access — so the precedence is unit-testable.
 */
export function resolveWizardProgressScope(params: {
  wizardType: string
  formationLeadId: string | null
  accountId: string | null
  contactId: string | null
}): WizardProgressScope | null {
  const { wizardType, formationLeadId, accountId, contactId } = params

  if (formationLeadId) {
    return { col: 'lead_id', val: formationLeadId, restrictToNoLead: false }
  }
  if (isContactScopedWizard(wizardType) && contactId) {
    return { col: 'contact_id', val: contactId, restrictToNoLead: true }
  }
  // Person-owned wizard (ITIN): keyed on the person even when they own a
  // company, matching createSD's rule that an ITIN service delivery never
  // carries an account_id. `restrictToNoLead` is deliberately FALSE — that flag
  // is formation's multi-company disambiguation and has no meaning here; an ITIN
  // sold inside a formation offer can legitimately carry a lead_id, and
  // inheriting formation's flag would hide that row and re-offer a filed wizard.
  if (isPersonOwnedWizard(wizardType) && contactId) {
    return { col: 'contact_id', val: contactId, restrictToNoLead: false }
  }
  if (accountId) {
    return { col: 'account_id', val: accountId, restrictToNoLead: false }
  }
  if (contactId) {
    return { col: 'contact_id', val: contactId, restrictToNoLead: false }
  }
  return null
}

/**
 * A formation submission must NEVER carry an account_id. A formation is for a
 * NEW company and lives on the contact (+lead) until the Articles of
 * Organization materialize the real account. Returns null for formation,
 * otherwise the provided account id unchanged.
 *
 * Server-side backstop against the THW Global hijack: an existing client who
 * reached the formation wizard via a link that dropped the ?lead= scope had
 * their new company's data attached to their EXISTING account (Adam Mihaly,
 * 2026-05-20, dev_task 358e8cbe).
 */
export function accountIdForWizardSubmission(
  wizardType: string,
  accountId: string | null | undefined,
): string | null {
  if (wizardType === "formation") return null
  // Person-owned (ITIN): the submission belongs to the person, matching the
  // service delivery. Without this, two members of one LLC who each buy an ITIN
  // share one company-keyed submission — the second person loads the first
  // person's passport and date of birth, and their own submit is a silent
  // no-op. Note the ITIN completion chain must therefore resolve the client's
  // Drive folder from the CONTACT's linked account, not from the submission.
  if (isPersonOwnedWizard(wizardType)) return null
  return accountId ?? null
}
