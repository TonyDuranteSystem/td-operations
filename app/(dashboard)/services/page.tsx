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
    .from('services')
    .select('id, service_name, service_type, account_id, status, start_date, end_date, billing_type, amount, amount_currency, current_step, total_steps, blocked_waiting_external, blocked_reason, blocked_since, sla_due_date, stage_entered_at, notes, updated_at')
    .in('status', ['Not Started', 'In Progress', 'Blocked'])
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

  const services = (rawServices ?? []).map(s => ({
    ...s,
    company_name: s.account_id ? accountMap[s.account_id] ?? null : null,
  }))

  // Group by status
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
    notStarted: services.filter(s => s.status === 'Not Started').length,
    inProgress: services.filter(s => s.status === 'In Progress').length,
    blocked: services.filter(s => s.blocked_waiting_external === true).length,
    withSla: services.filter(s => s.sla_due_date && s.sla_due_date <= today).length,
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
