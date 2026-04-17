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
 *   3. Tier-based fallback for onboarding clients (Commit C): per SOP
 *      v7.2 Phase 0 (sop_runbooks bcf88e7e v7.2), onboarding payment
 *      does NOT create an account or SDs — those are deferred to wizard
 *      submit (lib/jobs/handlers/onboarding-setup.ts). So an onboarding
 *      client between payment and wizard-submit has zero SDs and would
 *      otherwise see no path to the wizard. This branch shows the button
 *      whenever portal_tier='onboarding' AND no wizard_progress row with
 *      status='submitted' exists for this contact.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

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

  if (contactId && portalTier === "onboarding") {
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
