import { createClient } from '@/lib/supabase/server'
import { ServiceBoard } from '@/components/services/service-board'

const STATUS_ORDER = ['Not Started', 'In Progress', 'Blocked', 'Completed']

export default async function ServicesPage({
  searchParams,
}: {
  searchParams: { type?: string }
}) {
  const supabase = createClient()
  const today = new Date().toISOString().split('T')[0]
  const typeFilter = searchParams.type ?? ''

  let dbQuery = supabase
    .from('service_deliveries')
    .select('id, service_name, service_type, account_id, stage, status, start_date, end_date, notes, updated_at')
    .eq('status', 'active')
    .order('updated_at', { ascending: false })

  if (typeFilter) {
    dbQuery = dbQuery.eq('service_type', typeFilter)
  }

  const { data: rawServices } = await dbQuery

  // Get account names
  const accountIds = Array.from(new Set((rawServices ?? []).filter(s => s.account_id).map(s => s.account_id)))
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

  // Map service_deliveries to the shape ServiceBoard expects
  const services = (rawServices ?? []).map(s => ({
    id: s.id,
    service_name: s.service_name ?? s.service_type ?? 'Service',
    service_type: s.service_type ?? '',
    account_id: s.account_id,
    status: 'In Progress',
    start_date: s.start_date ?? null,
    end_date: s.end_date ?? null,
    billing_type: null,
    amount: null,
    amount_currency: null,
    current_step: null,
    total_steps: null,
    blocked_waiting_external: false,
    blocked_reason: null,
    blocked_since: null,
    sla_due_date: null,
    stage_entered_at: null,
    notes: s.notes ?? null,
    updated_at: s.updated_at,
    company_name: s.account_id ? accountMap[s.account_id] ?? null : null,
    current_stage: s.stage ?? null,
  }))

  // Group by status (all active SDs show as "In Progress")
  const columns = STATUS_ORDER.filter(s => s !== 'Completed').map(status => ({
    status,
    items: services.filter(s => s.status === status),
  }))

  // Get service type counts for filter
  const typeCounts: Record<string, number> = {}
  for (const s of services) {
    typeCounts[s.service_type] = (typeCounts[s.service_type] ?? 0) + 1
  }
  const serviceTypes = Object.entries(typeCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => ({ type, count }))

  const stats = {
    total: services.length,
    notStarted: 0,
    inProgress: services.length,
    blocked: 0,
    withSla: 0,
  }

  return (
    <div className="p-6 lg:p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Service Delivery</h1>
        <p className="text-muted-foreground text-sm mt-1">
          {stats.total} active services — {stats.blocked} blocked, {stats.withSla} SLA overdue
        </p>
      </div>
      <ServiceBoard
        columns={columns}
        stats={stats}
        serviceTypes={serviceTypes}
        typeFilter={typeFilter}
        today={today}
      />
    </div>
  )
}
