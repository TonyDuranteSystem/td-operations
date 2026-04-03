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
  searchParams: { q?: string; status?: string; page?: string; view?: string }
}) {
  const supabase = createClient()
  const query = searchParams.q?.trim() ?? ''
  const statusFilter = searchParams.status ?? 'all'
  const currentPage = Math.max(1, parseInt(searchParams.page ?? '1', 10) || 1)
  const viewMode = searchParams.view === 'kanban' ? 'kanban' : 'table'

  // For kanban view, fetch all non-converted/non-lost leads (up to 200)
  // For table view, use pagination as before
  const isKanban = viewMode === 'kanban'

  let dbQuery = supabase
    .from('leads')
    .select('id, full_name, email, phone, status, source, channel, language, referrer_name, call_date, offer_status, offer_year1_amount, offer_year1_currency, created_at', { count: 'exact' })
    .order('created_at', { ascending: false })

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

  const items: LeadListItem[] = (leads ?? []).map(l => ({
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
    offer_year1_amount: l.offer_year1_amount,
    offer_year1_currency: l.offer_year1_currency,
    created_at: l.created_at,
  }))

  const stats = {
    total: totalCount ?? 0,
    new: items.filter(l => l.status === 'New').length,
    contacted: items.filter(l => l.status === 'Contacted').length,
    qualified: items.filter(l => l.status === 'Qualified').length,
    converted: items.filter(l => l.status === 'Converted').length,
    lost: items.filter(l => l.status === 'Lost').length,
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
