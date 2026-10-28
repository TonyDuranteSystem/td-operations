/**
 * SS-4 Resubmit marker (dev job 25e460aa).
 *
 * When a faxed SS-4 is replaced by a corrected one, the earlier fax belongs to the OLD form. The "already faxed" lock on the fax panel
 * and in the fax send route must therefore only look at faxes sent AFTER the latest resubmit of that flow — otherwise the corrected SS-4
 * is told "a fax was already sent" (or, for a fax that was never confirmed, cannot be faxed at all).
 *
 * The marker is the `ss4_resubmitted` row that resubmitSs4 writes to the activity log with the flow's id.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

export const SS4_RESUBMIT_MARKER = "ss4_resubmitted"

/** ISO time of the latest resubmit for this flow, null when there is none. `error` set = could not be read (callers must not fail open). */
export async function latestSs4ResubmitAt(serviceDeliveryId: string): Promise<{ at: string | null; error: string | null }> {
  const { data, error } = await supabaseAdmin
    .from("action_log")
    .select("created_at")
    .eq("action_type", SS4_RESUBMIT_MARKER)
    .eq("service_delivery_id", serviceDeliveryId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) return { at: null, error: error.message }
  return { at: (data?.created_at as string | undefined) ?? null, error: null }
}
