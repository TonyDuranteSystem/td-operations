import { createClient } from '@/lib/supabase/server'
import { AuditBoard } from '@/components/audit/audit-board'

const PAGE_SIZE = 50

export default async function AuditPage({
  searchParams,
}: {
  searchParams: { q?: string; action?: string; table?: string; days?: string; page?: string }
}) {
  const supabase = createClient()

  const q = searchParams.q?.trim() ?? ''
  const actionFilter = searchParams.action ?? ''
  const tableFilter = searchParams.table ?? ''
  const daysFilter = searchParams.days ?? '7'
  const currentPage = Math.max(1, parseInt(searchParams.page ?? '1', 10) || 1)
  const offset = (currentPage - 1) * PAGE_SIZE

  // Build time filter
  let since: string | null = null
  if (daysFilter !== 'all') {
    const d = new Date()
    d.setDate(d.getDate() - parseInt(daysFilter, 10))
    since = d.toISOString()
  }

  // Build query
  let dbQuery = supabase
    .from('action_log')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })

  if (since) dbQuery = dbQuery.gte('created_at', since)
  if (actionFilter) dbQuery = dbQuery.eq('action_type', actionFilter)
  if (tableFilter) dbQuery = dbQuery.eq('table_name', tableFilter)
  if (q) dbQuery = dbQuery.ilike('summary', `%${q}%`)

  dbQuery = dbQuery.range(offset, offset + PAGE_SIZE - 1)

  const { data: rawEntries, count } = await dbQuery

  // Get account names for entries with account_id
  const accountIds = Array.from(
    new Set((rawEntries ?? []).filter(e => e.account_id).map(e => e.account_id))
  )
  let accountMap: Record<string, string> = {}
  if (accountIds.length > 0) {
    const { data: accounts } = await supabase
      .from('accounts')
      .select('id, company_name')
      .in('id', accountIds)
    if (accounts) {
      accountMap = Object.fromEntries(accounts.map(a => [a.id, a.company_name]))
    }
  }

  const entries = (rawEntries ?? []).map(e => ({
    ...e,
    company_name: e.account_id ? accountMap[e.account_id] ?? null : null,
  }))

  // Stats query (same filters but no pagination)
  let statsQuery = supabase
    .from('action_log')
    .select('action_type')
  if (since) statsQuery = statsQuery.gte('created_at', since)
  if (tableFilter) statsQuery = statsQuery.eq('table_name', tableFilter)
  if (q) statsQuery = statsQuery.ilike('summary', `%${q}%`)

  const { data: statsData } = await statsQuery

  const byType: Record<string, number> = {}
  for (const row of statsData ?? []) {
    byType[row.action_type] = (byType[row.action_type] || 0) + 1
  }

  const stats = {
    total: (statsData ?? []).length,
    byType,
  }

  // Get distinct table names for filter dropdown
  const { data: tableNamesRaw } = await supabase
    .from('action_log')
    .select('table_name')
  const tableNames = Array.from(
    new Set((tableNamesRaw ?? []).map(r => r.table_name))
  ).sort()

  const filters = {
    q,
    action: actionFilter,
    table: tableFilter,
    days: daysFilter,
    page: currentPage,
  }

  return (
    <div className="p-6 lg:p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Audit Log</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Cronologia di tutte le operazioni MCP — {stats.total} azioni
          {daysFilter !== 'all' ? ` negli ultimi ${daysFilter} giorni` : ''}
        </p>
      </div>
      <AuditBoard
        entries={entries}
        stats={stats}
        filters={filters}
        totalCount={count ?? 0}
        tableNames={tableNames}
      />
    </div>
  )
}
