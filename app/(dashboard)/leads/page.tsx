import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { LeadsTable } from '@/components/leads/leads-table'
import { LeadsKanban } from './components/leads-kanban'
import { LeadsViewToggle } from './components/leads-view-toggle'
import { CreateLeadButton } from './components/create-lead-button'
import type { LeadListItem } from '@/lib/types'

const PAGE_SIZE = 50

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: { q?: string; status?: string; page?: string; view?: string; client?: string }
}) {
  const supabase = createClient()
  const query = searchParams.q?.trim() ?? ''
  const statusFilter = searchParams.status ?? 'all'
  const currentPage = Math.max(1, parseInt(searchParams.page ?? '1', 10) || 1)
  const viewMode = searchParams.view === 'kanban' ? 'kanban' : 'table'
  // Existing-client bookings (dev job 93580372) are hidden from the default
  // view — they're not open sales leads. ?client=all reveals them. Applied to
  // BOTH table and kanban queries so a tagged booking can't silently keep
  // piling up in the pipeline board just because the table got filtered.
  const clientFilter = searchParams.client === 'all' ? 'all' : 'hide'

  // For kanban view, fetch all non-converted/non-lost leads (up to 200)
  // For table view, use pagination as before
  const isKanban = viewMode === 'kanban'

  let dbQuery = supabase
    .from('leads')
    .select('id, full_name, email, phone, status, source, channel, language, referrer_name, call_date, offer_status, offer_year1_amount, offer_year1_currency, created_at, existing_client_contact_id, offers(status, superseded_by, created_at)', { count: 'exact' })
    .order('created_at', { ascending: false })

  if (clientFilter === 'hide') {
    dbQuery = dbQuery.is('existing_client_contact_id', null)
  }

  if (!isKanban) {
    if (statusFilter && statusFilter !== 'all') {
      dbQuery = dbQuery.eq('status', statusFilter)
    }
    if (query) {
      dbQuery = dbQuery.or(`full_name.ilike.%${query}%,email.ilike.%${query}%`)
    }
    const from = (currentPage - 1) * PAGE_SIZE
    dbQuery = dbQuery.range(from, from + PAGE_SIZE - 1)
  } else {
    // Kanban: fetch all (up to 200), no status filter
    if (query) {
      dbQuery = dbQuery.or(`full_name.ilike.%${query}%,email.ilike.%${query}%`)
    }
    dbQuery = dbQuery.range(0, 199)
  }

  const { data: leads, count: totalCount } = await dbQuery
  const totalPages = Math.ceil((totalCount ?? 0) / PAGE_SIZE)

  // How many are hidden right now, so the toggle is never a silent omission.
  let hiddenCount = 0
  if (clientFilter === 'hide') {
    const { count } = await supabase
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .not('existing_client_contact_id', 'is', null)
    hiddenCount = count ?? 0
  }

  // "Has this call actually happened" — a fact (a recording came back), never
  // a guess from call_date. Batched: one query for the whole visible page,
  // matched on lead_id (the normal path) OR the lead's tagged contact_id
  // (Circleback can link a call to the CONTACT before the matching Calendly
  // lead even exists — confirmed load-bearing by council review).
  const leadIds = (leads ?? []).map(l => l.id)
  const taggedContactIds = Array.from(
    new Set((leads ?? []).map(l => l.existing_client_contact_id).filter((id): id is string => !!id))
  )
  const recordedLeadIds = new Set<string>()
  const recordedContactIds = new Set<string>()
  if (leadIds.length > 0) {
    const orParts = [`lead_id.in.(${leadIds.join(',')})`]
    if (taggedContactIds.length > 0) orParts.push(`contact_id.in.(${taggedContactIds.join(',')})`)
    const { data: calls } = await supabase
      .from('call_summaries')
      .select('lead_id, contact_id')
      .or(orParts.join(','))
    for (const c of calls ?? []) {
      if (c.lead_id) recordedLeadIds.add(c.lead_id)
      if (c.contact_id) recordedContactIds.add(c.contact_id)
    }
  }

  const items: LeadListItem[] = (leads ?? []).map(l => {
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
      existing_client_contact_id: l.existing_client_contact_id,
      has_call_recording: hasCallRecording,
    }
  })

  const stats = {
    total: totalCount ?? 0,
    new: items.filter(l => l.status === 'New').length,
    contacted: items.filter(l => l.status === 'Contacted').length,
    qualified: items.filter(l => l.status === 'Qualified').length,
    converted: items.filter(l => l.status === 'Converted').length,
    lost: items.filter(l => l.status === 'Lost').length,
  }

  const toggleParams = new URLSearchParams()
  if (query) toggleParams.set('q', query)
  if (statusFilter !== 'all') toggleParams.set('status', statusFilter)
  if (viewMode === 'kanban') toggleParams.set('view', 'kanban')
  if (clientFilter === 'hide') toggleParams.set('client', 'all')
  // page intentionally dropped on toggle — a different row count means the
  // current page number may no longer exist (matches the table/kanban toggle).

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

      {clientFilter === 'hide' && hiddenCount > 0 && (
        <Link
          href={`/leads?${toggleParams.toString()}`}
          className="inline-block mb-4 text-xs text-muted-foreground hover:text-zinc-700 underline"
        >
          {hiddenCount} existing-client booking{hiddenCount === 1 ? '' : 's'} hidden — show
        </Link>
      )}
      {clientFilter === 'all' && (
        <Link
          href={`/leads?${toggleParams.toString()}`}
          className="inline-block mb-4 text-xs text-muted-foreground hover:text-zinc-700 underline"
        >
          Showing existing-client bookings — hide
        </Link>
      )}

      {isKanban ? (
        <LeadsKanban items={items} />
      ) : (
        <LeadsTable
          items={items}
          query={query}
          statusFilter={statusFilter}
          stats={stats}
          currentPage={currentPage}
          totalPages={totalPages}
          totalCount={totalCount ?? 0}
        />
      )}
    </div>
  )
}
