import { supabaseAdmin } from "@/lib/supabase-admin"
import type { Json } from "@/lib/database.types"

export interface MarkWizardProgressSubmittedParams {
  progressId: string | null
  wizardType: string
  data: Record<string, unknown>
  accountId: string | null
  contactId: string | null
  leadId: string | null
  serviceDeliveryId?: string | null
}

/**
 * The ONE place that marks a wizard_progress row 'submitted' (dev job
 * 9a9c5cf5 — app/api/portal/wizard-submit/route.ts previously had 3
 * independent copies of this insert/update, all silently swallowing the
 * write error). Every call site checks the returned `.error` itself, since
 * how to react differs: fail loud when this is the client's only proof of
 * success, log-and-continue when a more important write already succeeded
 * by this point.
 */
export async function markWizardProgressSubmitted(
  params: MarkWizardProgressSubmittedParams,
): Promise<{ error: { message: string } | null }> {
  const { progressId, wizardType, data, accountId, contactId, leadId, serviceDeliveryId } = params
  const jsonData = data as unknown as Json
  return progressId
    ? await supabaseAdmin
        .from("wizard_progress")
        .update({ data: jsonData, status: "submitted", updated_at: new Date().toISOString() })
        .eq("id", progressId)
    : await supabaseAdmin
        .from("wizard_progress")
        .insert({
          wizard_type: wizardType,
          data: jsonData,
          account_id: accountId || null,
          contact_id: contactId || null,
          lead_id: leadId || null,
          service_delivery_id: serviceDeliveryId ?? null,
          status: "submitted",
          current_step: 99,
        })
}
