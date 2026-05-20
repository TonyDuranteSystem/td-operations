import { isContactScopedWizard } from './wizard-map'

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
  if (accountId) {
    return { col: 'account_id', val: accountId, restrictToNoLead: false }
  }
  if (contactId) {
    return { col: 'contact_id', val: contactId, restrictToNoLead: false }
  }
  return null
}
