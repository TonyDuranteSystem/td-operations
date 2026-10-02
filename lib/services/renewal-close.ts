/**
 * "Closes only by filing" (N1a C0, dev job be7da01a, Antonio 2026-10-02).
 *
 * A registered-agent renewal or an annual report can only be closed by "Mark Filed" on the Calendar: closing the
 * job is what moves the company's next renewal date, and only Mark Filed also saves the receipt and updates the
 * calendar entry. The setting lives on the service card (catalog_entries, catalog 'services'):
 *   metadata.closes_only_by_filing = true
 *   metadata.delivery_service_type = the job name (so a job not linked to its card is still recognised)
 *
 * The database rule `trg_delivery_renewal_close_guard` (migration 20261002-2300-renewal-close-guard.sql) is the
 * safety net for every writer; this module only gives the shared "move a job forward" path a plain message first.
 * The two must apply the same match — keep `cardClosesOnlyByFiling` in step with the trigger.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

export const CLOSES_ONLY_BY_FILING_MESSAGE =
  'A registered-agent renewal or an annual report can only be closed with "Mark Filed" on the Calendar — it saves the receipt and moves the next date.'

export interface ServiceCardLite {
  id: string
  metadata: Record<string, unknown> | null
}

/** Same match as the database rule: a card with the setting, matched by the job's card link OR by its job name. */
export function cardClosesOnlyByFiling(
  cards: ServiceCardLite[],
  serviceType: string | null | undefined,
  serviceTypeEntryId: string | null | undefined,
): boolean {
  return cards.some(card => {
    const md = card.metadata ?? {}
    if (md.closes_only_by_filing !== true && md.closes_only_by_filing !== "true") return false
    if (serviceTypeEntryId && card.id === serviceTypeEntryId) return true
    return !!serviceType && md.delivery_service_type === serviceType
  })
}

/** Loads the service cards that carry the setting, then applies the match. Throws on a read error. */
export async function closesOnlyByFiling(
  serviceType: string | null | undefined,
  serviceTypeEntryId: string | null | undefined,
): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("catalog_entries")
    .select("id, metadata")
    .eq("catalog_id", "services")
    .eq("metadata->>closes_only_by_filing", "true")
  if (error) throw new Error(`closesOnlyByFiling: ${error.message}`)
  return cardClosesOnlyByFiling((data ?? []) as ServiceCardLite[], serviceType, serviceTypeEntryId)
}
