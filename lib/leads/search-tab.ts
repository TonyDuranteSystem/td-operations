// Live search on the Leads page (2026-11-02, Antonio: "when I search, the list should move dynamically to the name if it
// exists"). The list has three tabs; a person lives in exactly one of them (same rule as the page: Converted first, then
// "already a client", then everything else). While typing, the list shows the typed text on the current tab, and if the
// current tab has no match but another one does, it moves to that tab by itself.
// Pure: no database access.

export type LeadTab = 'leads' | 'clients' | 'converted'

export const TAB_LABEL: Record<LeadTab, string> = {
  leads: 'New Leads',
  clients: 'Existing Clients',
  converted: 'Converted',
}

export interface TabbableLead {
  status: string | null
  existing_client_contact_id: string | null
}

/** Which tab a lead is listed in. Mirrors the filters in the Leads page query. */
export function tabOfLead(l: TabbableLead): LeadTab {
  if (l.status === 'Converted') return 'converted'
  if (l.existing_client_contact_id) return 'clients'
  return 'leads'
}

/** The tab named in the page address (anything unknown means the New Leads tab). */
export function tabFromParam(v: string | null | undefined): LeadTab {
  return v === 'clients' || v === 'converted' ? v : 'leads'
}

/** The page-address value for a tab (empty for the New Leads tab, which is the default). */
export function paramOfTab(t: LeadTab): string {
  return t === 'leads' ? '' : t
}

export interface LiveTarget {
  /** The tab the list should show. */
  tab: LeadTab
  /** Other tabs that also have a match, with how many (for small "also in ..." buttons). */
  others: { tab: LeadTab; count: number }[]
}

/**
 * Decide the tab for the typed text. Stay on the current tab when it has a match (we never pull Antonio away from where he is
 * when the answer is already there); otherwise go to the tab of the first (newest) match; with no match at all, stay put.
 */
export function decideLiveTarget(results: TabbableLead[], current: LeadTab): LiveTarget {
  const counts: Record<LeadTab, number> = { leads: 0, clients: 0, converted: 0 }
  for (const r of results) counts[tabOfLead(r)]++
  const tab: LeadTab = results.length === 0 || counts[current] > 0 ? current : tabOfLead(results[0])
  const others = (Object.keys(counts) as LeadTab[])
    .filter(t => t !== tab && counts[t] > 0)
    .map(t => ({ tab: t, count: counts[t] }))
  return { tab, others }
}
