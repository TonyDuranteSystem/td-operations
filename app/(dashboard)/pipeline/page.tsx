import { createClient } from '@/lib/supabase/server'
import { PipelineBoard } from '@/components/pipeline/pipeline-board'
import type { Deal } from '@/lib/types'

const STAGE_ORDER = [
  'Initial Consultation',
  'Offer Sent',
  'Negotiation',
  'Agreement Signed',
  'Paid',
  'Closed Won',
  'Closed Lost',
]

export default async function PipelinePage() {
  const supabase = createClient()

  const { data: rawDeals } = await supabase
    .from('deals')
    .select('id, deal_name, account_id, stage, amount, amount_currency, close_date, deal_type, deal_category, service_type, payment_status, notes, created_at, updated_at')
    .order('created_at', { ascending: false })

  // Get account names
  const accountIds = Array.from(new Set((rawDeals ?? []).filter(d => d.account_id).map(d => d.account_id)))
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

  const deals = (rawDeals ?? []).map(d => ({
    ...d,
    company_name: d.account_id ? accountMap[d.account_id] ?? null : null,
  }))

  // Group by stage
  const stages = STAGE_ORDER.map(stage => ({
    stage,
    deals: deals.filter(d => d.stage === stage),
    total: deals.filter(d => d.stage === stage).reduce((sum, d) => sum + (d.amount ?? 0), 0),
  }))

  const stats = {
    total: deals.length,
    totalValue: deals.reduce((sum, d) => sum + (d.amount ?? 0), 0),
    open: deals.filter(d => d.stage !== 'Closed Won').length,
    openValue: deals.filter(d => d.stage !== 'Closed Won').reduce((sum, d) => sum + (d.amount ?? 0), 0),
    closedWon: deals.filter(d => d.stage === 'Closed Won').length,
    closedWonValue: deals.filter(d => d.stage === 'Closed Won').reduce((sum, d) => sum + (d.amount ?? 0), 0),
  }

  return (
    <div className="p-6 lg:p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Pipeline</h1>
        <p className="text-muted-foreground text-sm mt-1">
          {stats.open} deal aperti · ${stats.openValue.toLocaleString()} in pipeline
        </p>
      </div>
      <PipelineBoard stages={stages} stats={stats} />
    </div>
  )
}
