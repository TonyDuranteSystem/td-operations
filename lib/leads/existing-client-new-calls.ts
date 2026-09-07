/**
 * Match recent Circleback calls back to "existing client" leads — a lead
 * already marked Converted, or tagged with existing_client_contact_id — so
 * staff can see a rebooked call without having to remember to open the
 * Converted/Clients tab that would otherwise be the only place it shows.
 *
 * Why matching by contact matters too: Circleback can link a call to a
 * CONTACT before/without a lead_id (confirmed load-bearing elsewhere on this
 * page), so a call must be checked against both a lead's own id and its
 * linked contact id (existing_client_contact_id, or converted_to_contact_id
 * for a fully Converted lead).
 *
 * Pure/derive-only — callers pass in already-window-filtered calls (e.g. the
 * last 14 days) and already-fetched "existing client" leads; no DB access
 * here, so this is unit-testable without a live database.
 */

export interface ExistingClientLeadRow {
  id: string
  full_name: string
  existing_client_contact_id: string | null
  converted_to_contact_id: string | null
}

export interface CallSummaryRow {
  lead_id: string | null
  contact_id: string | null
  created_at: string | null
}

export interface ExistingClientNewCall {
  id: string
  full_name: string
  call_date: string
}

export function findExistingClientNewCalls(
  leads: ExistingClientLeadRow[],
  recentCalls: CallSummaryRow[]
): ExistingClientNewCall[] {
  const leadsById = new Map(leads.map(l => [l.id, l]))
  const leadsByContactId = new Map<string, ExistingClientLeadRow>()
  for (const l of leads) {
    const contactId = l.existing_client_contact_id ?? l.converted_to_contact_id
    if (contactId) leadsByContactId.set(contactId, l)
  }

  // One entry per lead — the MOST RECENT matching call, not every call.
  const latestByLead = new Map<string, string>()
  for (const call of recentCalls) {
    if (!call.created_at) continue
    const matched =
      (call.lead_id && leadsById.get(call.lead_id)) ||
      (call.contact_id && leadsByContactId.get(call.contact_id)) ||
      null
    if (!matched) continue
    const current = latestByLead.get(matched.id)
    if (!current || call.created_at > current) {
      latestByLead.set(matched.id, call.created_at)
    }
  }

  return Array.from(latestByLead.entries())
    .map(([id, call_date]) => ({ id, full_name: leadsById.get(id)!.full_name, call_date }))
    .sort((a, b) => b.call_date.localeCompare(a.call_date))
}
