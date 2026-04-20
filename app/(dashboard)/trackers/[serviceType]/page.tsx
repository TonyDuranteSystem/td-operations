import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { SERVICE_TRACKER_SLUGS } from '@/lib/constants'
import { TrackerBoard } from '@/components/trackers/tracker-board'
import { BankReferralsAdmin } from '@/components/banking/bank-referrals-admin'
import type { PipelineStage, ServiceDelivery, TrackerColumn } from '@/lib/types'

interface Props {
  params: Promise<{ serviceType: string }>
}

export default async function TrackerDetailPage({ params }: Props) {
  const { serviceType: slug } = await params
  const dbServiceType = SERVICE_TRACKER_SLUGS[slug]
  if (!dbServiceType) notFound()

  const supabase = createClient()

  // Fetch pipeline stages + deliveries + tasks in parallel
  const [stagesRes, deliveriesRes] = await Promise.all([
    supabase
      .from('pipeline_stages')
      .select('id, service_type, stage_name, stage_order, auto_tasks, requires_approval')
      .eq('service_type', dbServiceType)
      .order('stage_order', { ascending: true }),
    supabase
      .from('service_deliveries')
      .select('id, service_name, service_type, pipeline, stage, stage_order, stage_entered_at, account_id, contact_id, deal_id, status, assigned_to, amount, amount_currency, notes, start_date, end_date, updated_at, created_at')
      .eq('service_type', dbServiceType)
      .in('status', ['active', 'completed'])
      .order('stage_order', { ascending: true }),
  ])

  const stages = (stagesRes.data ?? []) as PipelineStage[]
  const rawDeliveries = (deliveriesRes.data ?? []) as ServiceDelivery[]

  // Get account names for all deliveries
  const accountIds = Array.from(new Set(rawDeliveries.filter(d => d.account_id).map(d => d.account_id!)))
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

  // Get task counts per delivery
  const deliveryIds = rawDeliveries.map(d => d.id)
  const taskCountMap: Record<string, { total: number; open: number }> = {}
  if (deliveryIds.length > 0) {
    const { data: tasks } = await supabase
      .from('tasks')
      .select('delivery_id, status')
      .in('delivery_id', deliveryIds)
    if (tasks) {
      for (const t of tasks) {
        if (!t.delivery_id) continue
        if (!taskCountMap[t.delivery_id]) taskCountMap[t.delivery_id] = { total: 0, open: 0 }
        taskCountMap[t.delivery_id].total++
        if (t.status !== 'Done' && t.status !== 'Cancelled') taskCountMap[t.delivery_id].open++
      }
    }
  }

  // Enrich deliveries
  const deliveries: ServiceDelivery[] = rawDeliveries.map(d => ({
    ...d,
    company_name: d.account_id ? accountMap[d.account_id] ?? null : null,
    task_count: taskCountMap[d.id]?.total ?? 0,
    open_task_count: taskCountMap[d.id]?.open ?? 0,
  }))

  // Build columns: group deliveries by stage
  const columns: TrackerColumn[] = stages.map(stage => ({
    stage,
    deliveries: deliveries.filter(d =>
      d.status === 'active' && d.stage === stage.stage_name
    ),
  }))

  // Completed column (all completed deliveries regardless of stage)
  const completedDeliveries = deliveries.filter(d => d.status === 'completed')

  // Stats
  const activeCount = deliveries.filter(d => d.status === 'active').length
  const completedCount = completedDeliveries.length

  return (
    <div className="p-6 lg:p-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{dbServiceType} Tracker</h1>
          <p className="text-muted-foreground text-sm mt-1">
            {activeCount} active · {completedCount} completed · {stages.length} stages
          </p>
        </div>
      </div>

      <TrackerBoard
        columns={columns}
        completedDeliveries={completedDeliveries}
        serviceType={dbServiceType}
        slug={slug}
      />

      {dbServiceType === 'Banking Fintech' && <BankReferralsAdmin />}
    </div>
  )
}
