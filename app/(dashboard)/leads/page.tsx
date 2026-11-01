import { createClient } from '@/lib/supabase/server'
import { LeadsTable } from '@/components/leads/leads-table'
import { ExistingClientNewCalls } from '@/components/leads/existing-client-new-calls'
import { LeadsKanban } from './components/leads-kanban'
import { LeadsViewToggle } from './components/leads-view-toggle'
import { LeadsClientFilterToggle } from './components/leads-client-filter-toggle'
import { CreateLeadButton } from './components/create-lead-button'
import type { LeadListItem } from '@/lib/types'
import { findExistingClientNewCalls } from '@/lib/leads/existing-client-new-calls'
import { findLeadIdsByPhone, leadSearchOrFilter } from '@/lib/leads/phone-search'
import { buildClientEmailSet, isLiveClient } from '@/lib/leads/client-match'
import { LeadsFilterBar } from '@/components/leads/leads-filter-bar'
import { parseLeadFilters, filterLeads, quickCounts, distinctValues } from '@/lib/leads/list-filters'

const NEW_CALL_WINDOW_DAYS = 14

const PAGE_SIZE = 50
const KANBAN_LIMIT = 200
// One group of leads is fetched whole so the filters and button counts are exact.
const GROUP_FETCH_LIMIT = 1000

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>
}) {
  const supabase = createClient()
  const str = (v: string | string[] | undefined) => (Array.isArray(v) ? (v[0] ?? '') : (v ?? ''))
  const query = str(searchParams.q).trim()
  const filters = parseLeadFilters(searchParams)
  const currentPage = Math.max(1, parseInt(str(searchParams.page) || '1', 10) || 1)
  const viewMode = str(searchParams.view) === 'kanban' ? 'kanban' : 'table'
  // A real 3-way switch (dev job 93580372) — not "reveal on top of", but "show
  // exactly one group" — between the open sales pipeline, bookings from
  // people who are already clients, and leads that actually converted.
  // Mutually exclusive: Converted status wins the split first (a definitive,
  // final state), then the existing-client tag, then everything else is a
  // real open lead. Applied to BOTH table and kanban queries so a row can't
  // silently pile up in the pipeline board just because the table switched.
  const rawClientFilter = str(searchParams.client)
  const clientFilter: 'leads' | 'clients' | 'converted' =
    rawClientFilter === 'clients' ? 'clients' : rawClientFilter === 'converted' ? 'converted' : 'leads'

  const isKanban = viewMode === 'kanban'

  // Phone-looking search text also matches phones stored in any format.
  const phoneIds = query ? await findLeadIdsByPhone(supabase, query) : []
  const searchFilter = leadSearchOrFilter(query, phoneIds)

  // The whole selected group (name/email/phone search applied in the database).
  // Every other filter is applied below on the finished rows, because "has a
  // recording" and "current offer" are not columns on the lead. The group is a
  // few hundred rows, so one fetch keeps the table, the board and the button
  // counts all using the same rules (dev job 6fc63c52).
  let dbQuery = supabase
    .from('leads')
    .select('id, full_name, email, phone, status, source, channel, language, referrer_name, call_date, offer_status, offer_year1_amount, offer_year1_currency, created_at, updated_at, existing_client_contact_id, offers(status, superseded_by, created_at)')
    .order('created_at', { ascending: false })

  if (clientFilter === 'converted') {
    dbQuery = dbQuery.eq('status', 'Converted')
  } else if (clientFilter === 'clients') {
    dbQuery = dbQuery.not('existing_client_contact_id', 'is', null).neq('status', 'Converted')
  } else {
    dbQuery = dbQuery.is('existing_client_contact_id', null).neq('status', 'Converted')
  }
  if (query) dbQuery = dbQuery.or(searchFilter)

  const { data: leads } = await dbQuery.range(0, GROUP_FETCH_LIMIT - 1)

  // Real counts for all three switch buttons, not just the active one — so
  // clicking over is never a guess at what's on the other side.
  const [leadsCountRes, clientsCountRes, convertedCountRes] = await Promise.all([
    supabase.from('leads').select('id', { count: 'exact', head: true }).is('existing_client_contact_id', null).neq('status', 'Converted'),
    supabase.from('leads').select('id', { count: 'exact', head: true }).not('existing_client_contact_id', 'is', null).neq('status', 'Converted'),
    supabase.from('leads').select('id', { count: 'exact', head: true }).eq('status', 'Converted'),
  ])

  // "Has this call actually happened" — a fact (a recording came back), never
  // a guess from call_date. Every call recording linked to a lead or contact,
  // paged so growth past one page can never silently drop some.
  const recordedLeadIds = new Set<string>()
  const recordedContactIds = new Set<string>()
  if ((leads ?? []).length > 0) {
    for (let from = 0; ; from += 1000) {
      const { data: calls } = await supabase
        .from('call_summaries')
        .select('lead_id, contact_id')
        .or('lead_id.not.is.null,contact_id.not.is.null')
        .order('id')
        .range(from, from + 999)
      for (const c of calls ?? []) {
        if (c.lead_id) recordedLeadIds.add(c.lead_id)
        if (c.contact_id) recordedContactIds.add(c.contact_id)
      }
      if ((calls ?? []).length < 1000) break
    }
  }

  // Contacts that belong to at least one company — for the live "Already a
  // client" badge (exact email, badge only, never moves a lead between tabs).
  const { data: clientContacts } = await supabase
    .from('contacts')
    .select('email, account_contacts!inner(account_id)')
    .not('email', 'is', null)
    .range(0, 4999)
  const clientEmails = buildClientEmailSet(clientContacts ?? [])

  const allItems: LeadListItem[] = (leads ?? []).map(l => {
    // Live current-offer status from the offers table (authoritative). Pick the
    // non-superseded offer, else the most recent — same rule as the lead detail page.
    const offersArr = (Array.isArray((l as { offers?: unknown }).offers)
      ? (l as { offers: Array<{ status: string | null; superseded_by: string | null; created_at: string | null }> }).offers
      : [])
    const currentOffer =
      offersArr.find(o => o.status !== 'superseded') ??
      [...offersArr].sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))[0] ??
      null
    const hasCallRecording =
      recordedLeadIds.has(l.id) ||
      (!!l.existing_client_contact_id && recordedContactIds.has(l.existing_client_contact_id))
    return {
      id: l.id,
      full_name: l.full_name,
      email: l.email,
      phone: l.phone,
      status: l.status,
      source: l.source,
      channel: l.channel,
      language: l.language,
      referrer_name: l.referrer_name,
      call_date: l.call_date,
      offer_status: l.offer_status,
      current_offer_status: currentOffer?.status ?? null,
      offer_year1_amount: l.offer_year1_amount,
      offer_year1_currency: l.offer_year1_currency,
      created_at: l.created_at,
      updated_at: l.updated_at,
      existing_client_contact_id: l.existing_client_contact_id,
      has_call_recording: hasCallRecording,
      is_live_client: l.status !== 'Converted' && !l.existing_client_contact_id && isLiveClient(l.email, clientEmails),
    }
  })

  const quickButtonCounts = quickCounts(allItems)
  const sourceOptions = distinctValues(allItems.map(i => i.source))
  const referrerOptions = distinctValues(allItems.map(i => i.referrer_name))
  const filtered = filterLeads(allItems, filters, { ignoreStatus: isKanban })

  const totalCount = filtered.length
  const totalPages = Math.ceil(totalCount / PAGE_SIZE)
  // Kanban shows everything that matches (capped, as before); the table pages.
  const items = isKanban
    ? filtered.slice(0, KANBAN_LIMIT)
    : filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)

  const stats = {
    total: totalCount,
    new: filtered.filter(l => l.status === 'New').length,
    contacted: filtered.filter(l => l.status === 'Contacted').length,
    qualified: filtered.filter(l => l.status === 'Qualified').length,
    converted: filtered.filter(l => l.status === 'Converted').length,
    lost: filtered.filter(l => l.status === 'Lost').length,
  }

  // Existing clients with a new call — independent of the tab/pagination
  // above, so it stays visible no matter which of the 3 tabs is selected.
  const { data: existingClientLeads } = await supabase
    .from('leads')
    .select('id, full_name, existing_client_contact_id, converted_to_contact_id, converted_at')
    .or('status.eq.Converted,existing_client_contact_id.not.is.null')

  let existingClientNewCalls: ReturnType<typeof findExistingClientNewCalls> = []
  if (existingClientLeads && existingClientLeads.length > 0) {
    const windowStart = new Date(Date.now() - NEW_CALL_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString()
    const ecLeadIds = existingClientLeads.map(l => l.id)
    const ecContactIds = Array.from(new Set(
      existingClientLeads.map(l => l.existing_client_contact_id ?? l.converted_to_contact_id).filter((id): id is string => !!id)
    ))
    const orParts = [`lead_id.in.(${ecLeadIds.join(',')})`]
    if (ecContactIds.length > 0) orParts.push(`contact_id.in.(${ecContactIds.join(',')})`)
    const { data: recentCalls } = await supabase
      .from('call_summaries')
      .select('lead_id, contact_id, created_at')
      .gte('created_at', windowStart)
      .or(orParts.join(','))
    existingClientNewCalls = findExistingClientNewCalls(existingClientLeads, recentCalls ?? [])
  }

  return (
    <div className="p-6 lg:p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Leads</h1>
          <p className="text-muted-foreground text-sm mt-1">
            {stats.total} leads — {stats.new} New, {stats.contacted} Contacted, {stats.qualified} Qualified, {stats.converted} Converted
          </p>
        </div>
        <div className="flex items-center gap-3">
          <CreateLeadButton />
          <LeadsViewToggle currentView={viewMode} />
        </div>
      </div>

      <ExistingClientNewCalls items={existingClientNewCalls} />

      <div className="mb-4">
        <LeadsClientFilterToggle
          currentFilter={clientFilter}
          leadsCount={leadsCountRes.count ?? 0}
          clientsCount={clientsCountRes.count ?? 0}
          convertedCount={convertedCountRes.count ?? 0}
        />
      </div>

      <div className="mb-4">
        <LeadsFilterBar
          query={query}
          filters={filters}
          sources={sourceOptions}
          referrers={referrerOptions}
          quickCounts={quickButtonCounts}
          isKanban={isKanban}
          shownCount={totalCount}
        />
      </div>

      {isKanban ? (
        <LeadsKanban items={items} />
      ) : (
        <LeadsTable
          items={items}
          stats={stats}
          currentPage={currentPage}
          totalPages={totalPages}
          totalCount={totalCount ?? 0}
        />
      )}
    </div>
  )
}
