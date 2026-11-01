// Filters for the CRM Leads list (dev job 6fc63c52, step 1).
//
// Everything here is pure and works on the already-built list rows, so the
// page can apply the same rules to the table, the board and the button
// counts. Nothing here reads or writes the database.

export const LEAD_STATUSES = [
  'New',
  'Contacted',
  'Qualified',
  'Call Scheduled',
  'Call Done',
  'Offer Sent',
  'Negotiating',
  'Suspended',
  'Converted',
  'Lost',
] as const

export const OFFER_FILTERS = [
  { value: 'none', label: 'No offer' },
  { value: 'draft', label: 'Draft' },
  { value: 'sent', label: 'Sent' },
  { value: 'viewed', label: 'Viewed' },
  { value: 'signed', label: 'Signed' },
  { value: 'completed', label: 'Completed' },
] as const

export const CALL_FILTERS = [
  { value: 'recorded', label: 'Call recorded' },
  { value: 'not_recorded', label: 'No recording' },
  { value: 'date_passed', label: 'Call date passed' },
] as const

/** Days without any change on a lead before "Offer sent" counts as stuck. */
export const OFFER_STALE_DAYS = 5

export type QuickKey = 'call_happened' | 'call_done_no_offer' | 'offer_stale'

export const QUICK_FILTERS: { key: QuickKey; label: string; hint: string }[] = [
  {
    key: 'call_happened',
    label: 'Call happened, still Call Scheduled',
    hint: 'A call recording came back but the status was never moved.',
  },
  {
    key: 'call_done_no_offer',
    label: 'Call Done, no offer',
    hint: 'The call is done and no offer exists yet.',
  },
  {
    key: 'offer_stale',
    label: `Offer sent, no change in ${OFFER_STALE_DAYS}+ days`,
    hint: 'Measured from the lead\'s last edit, so any edit restarts the count.',
  },
]

export interface LeadListFilters {
  status: string
  src: string
  ref: string
  offer: string
  call: string
  quick: QuickKey | ''
}

/** The row fields the filters need — a subset of the list row the page builds. */
export interface FilterableLead {
  status: string | null
  source: string | null
  referrer_name: string | null
  call_date: string | null
  current_offer_status: string | null
  has_call_recording: boolean
  updated_at: string | null
}

const first = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? '') : (v ?? ''))

export function parseLeadFilters(sp: Record<string, string | string[] | undefined>): LeadListFilters {
  const status = first(sp.status)
  const offer = first(sp.offer)
  const call = first(sp.call)
  const quick = first(sp.quick)
  return {
    status: status && status !== 'all' ? status : '',
    src: first(sp.src),
    ref: first(sp.ref),
    offer: OFFER_FILTERS.some(o => o.value === offer) ? offer : '',
    call: CALL_FILTERS.some(c => c.value === call) ? call : '',
    quick: QUICK_FILTERS.some(q => q.key === quick) ? (quick as QuickKey) : '',
  }
}

export function hasActiveFilters(f: LeadListFilters): boolean {
  return !!(f.status || f.src || f.ref || f.offer || f.call || f.quick)
}

/** Today's date (YYYY-MM-DD) in New York — the business clock, not UTC. */
export function todayInNewYork(now: Date = new Date()): string {
  return now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}

function callDatePassed(lead: FilterableLead, today: string): boolean {
  if (!lead.call_date) return false
  return lead.call_date.slice(0, 10) < today
}

function daysSince(iso: string | null, now: Date): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return null
  return Math.floor((now.getTime() - t) / 86_400_000)
}

export function matchesQuick(key: QuickKey, lead: FilterableLead, now: Date = new Date()): boolean {
  switch (key) {
    case 'call_happened':
      return lead.status === 'Call Scheduled' && lead.has_call_recording
    case 'call_done_no_offer':
      return lead.status === 'Call Done' && !lead.current_offer_status
    case 'offer_stale': {
      if (lead.status !== 'Offer Sent') return false
      const d = daysSince(lead.updated_at, now)
      return d !== null && d >= OFFER_STALE_DAYS
    }
  }
}

export function quickCounts(leads: FilterableLead[], now: Date = new Date()): Record<QuickKey, number> {
  const counts: Record<QuickKey, number> = { call_happened: 0, call_done_no_offer: 0, offer_stale: 0 }
  for (const l of leads) {
    for (const q of QUICK_FILTERS) if (matchesQuick(q.key, l, now)) counts[q.key]++
  }
  return counts
}

/**
 * Apply every active filter. `ignoreStatus` is for the board, which already
 * shows one column per status — a status filter there would just empty
 * the other columns.
 */
export function filterLeads<T extends FilterableLead>(
  leads: T[],
  f: LeadListFilters,
  opts: { now?: Date; ignoreStatus?: boolean } = {},
): T[] {
  const now = opts.now ?? new Date()
  const today = todayInNewYork(now)
  return leads.filter(l => {
    if (f.status && !opts.ignoreStatus && l.status !== f.status) return false
    if (f.src && (l.source ?? '') !== f.src) return false
    if (f.ref && (l.referrer_name ?? '') !== f.ref) return false
    if (f.offer) {
      if (f.offer === 'none' ? !!l.current_offer_status : l.current_offer_status !== f.offer) return false
    }
    if (f.call === 'recorded' && !l.has_call_recording) return false
    if (f.call === 'not_recorded' && l.has_call_recording) return false
    if (f.call === 'date_passed' && !callDatePassed(l, today)) return false
    if (f.quick && !matchesQuick(f.quick, l, now)) return false
    return true
  })
}

/** Distinct non-empty values, sorted — for the source / referrer dropdowns. */
export function distinctValues(values: (string | null)[]): string[] {
  return Array.from(new Set(values.filter((v): v is string => !!v && v.trim() !== ''))).sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' }),
  )
}
