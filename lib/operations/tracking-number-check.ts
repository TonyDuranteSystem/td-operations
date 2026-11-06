/**
 * "Is the IRS mailing tracking number still missing for this job?" — the one lookup behind the tracking lock, used by BOTH the stage move
 * (advanceServiceDelivery, step 4c) and the automatic move when a step's to-dos are all done (lib/mcp/tools/crm.ts), so the two cannot disagree.
 * A failed read counts as missing (the lock fails closed, as it always did).
 */
import { supabaseAdmin } from '@/lib/supabase-admin'

export async function trackingNumberMissing(serviceDeliveryId: string): Promise<boolean> {
  // irs_shipment_tracking isn't in the generated types until the migration is promoted to production.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (supabaseAdmin as any)
    .from('irs_shipment_tracking')
    .select('tracking_number')
    .eq('service_delivery_id', serviceDeliveryId)
    .maybeSingle()
  return !data?.tracking_number
}
