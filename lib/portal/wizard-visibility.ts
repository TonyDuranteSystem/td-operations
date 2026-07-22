/**
 * P3.4 #1 Commit C — portal sidebar "Complete Setup" visibility.
 *
 * The portal sidebar shows a "Complete Setup" button when the contact
 * needs to fill a wizard. Three branches in priority order:
 *
 *   1. SD-based by account_id (selectedAccountId is set): show button if
 *      any active service_delivery on that account has a wizard-eligible
 *      service_type.
 *   2. SD-based by contact_id fallback (no selectedAccountId): show
 *      button if any active service_delivery linked only to the contact
 *      (account_id IS NULL) has a wizard-eligible service_type.
 *   3. Tier-based fallback for formation/onboarding clients (Commit C +
 *      Step 4 refactor): per SOP v7.2 Phase 0 (sop_runbooks bcf88e7e
 *      v7.2), payment does NOT create an account or SDs — those are
 *      deferred to wizard submit (lib/jobs/handlers/onboarding-setup.ts).
 *      So a formation or onboarding client between payment and wizard-
 *      submit has zero SDs and would otherwise see no path to the wizard.
 *      This branch shows the button whenever portal_tier is 'formation'
 *      or 'onboarding' AND no wizard_progress row with status='submitted'
 *      exists for this contact.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import {
  getContactScopedDiscoveryServiceTypes,
  getPersonOwnedServiceTypes,
  PERSON_OWNED_WIZARD_TYPES,
} from "@/lib/portal/wizard-map"

export const WIZARD_SERVICE_TYPES = [
  "Company Formation",
  "Banking Fintech",
  "Company Closure",
  "ITIN",
  "ITIN Renewal",
  "Tax Return",
] as const

export interface ComputeHasWizardPendingParams {
  contactId: string | null
  selectedAccountId: string
  portalTier: string
}

export async function computeHasWizardPending(
  params: ComputeHasWizardPendingParams,
): Promise<boolean> {
  const { contactId, selectedAccountId, portalTier } = params

  if (selectedAccountId) {
    const { data } = await supabaseAdmin
      .from("service_deliveries")
      .select("service_type")
      .eq("account_id", selectedAccountId)
      .in("status", ["active"])
      .in("service_type", WIZARD_SERVICE_TYPES as unknown as string[])
      .limit(1)
    if ((data?.length ?? 0) > 0) return true
  } else if (contactId) {
    const { data } = await supabaseAdmin
      .from("service_deliveries")
      .select("service_type")
      .eq("contact_id", contactId)
      .is("account_id", null)
      .in("status", ["active"])
      .in("service_type", WIZARD_SERVICE_TYPES as unknown as string[])
      .limit(1)
    if ((data?.length ?? 0) > 0) return true
  }

  // Contact-scoped fallback: a contact may be a managed-account holder AND also
  // have a contact-scoped SD — a flexible type (Closure — closing an external
  // LLC that isn't a CRM account) or a person-owned one (ITIN, which is ALWAYS
  // contact-scoped). The two account/contact branches above miss this case
  // because the account branch only queries account-scoped SDs and the contact
  // branch only fires when no account is selected. Check explicitly when
  // contactId is set. Without this, a client who owns a company and buys an
  // ITIN standalone gets no "Complete Setup" entrance at all (Pietro De
  // Pellegrino, 2026-07-21).
  if (contactId) {
    const flexibleTypes = getContactScopedDiscoveryServiceTypes()
    if (flexibleTypes.length > 0) {
      const { data: flex } = await supabaseAdmin
        .from("service_deliveries")
        .select("service_type")
        .eq("contact_id", contactId)
        .is("account_id", null)
        .in("status", ["active"])
        .in("service_type", flexibleTypes)
        .limit(10)
      const found = flex ?? []
      // An ITIN service delivery stays `active` for the whole application — it
      // is only marked complete when the IRS letter arrives, months later. So
      // "an active ITIN exists" does NOT mean "the client still owes us the
      // questionnaire": once they have submitted it, keeping the entrance up
      // nags them forever and lets them re-open their own filed application.
      // Suppress the person-owned SDs whose wizard is already submitted, and
      // decide on what remains. Flexible (closure) behaviour is unchanged.
      const personOwnedServiceTypes = new Set(getPersonOwnedServiceTypes())
      const stillPending = found.filter((r) => !personOwnedServiceTypes.has(r.service_type))
      if (found.length > stillPending.length) {
        const { data: submittedItin } = await supabaseAdmin
          .from("wizard_progress")
          .select("id")
          .eq("contact_id", contactId)
          .in("wizard_type", [...PERSON_OWNED_WIZARD_TYPES])
          .eq("status", "submitted")
          .limit(1)
        if (!submittedItin?.length) return true
      }
      if (stillPending.length > 0) return true
    }
  }

  if (contactId && (portalTier === "onboarding" || portalTier === "formation")) {
    const { data: submitted } = await supabaseAdmin
      .from("wizard_progress")
      .select("id")
      .eq("contact_id", contactId)
      .eq("status", "submitted")
      .limit(1)
    if (!submitted?.length) return true
  }

  return false
}
