import { differenceInDays } from 'date-fns'
import { createClient } from '@/lib/supabase/server'
import { SERVICE_TYPE_TO_SLUG } from '@/lib/constants'
import { JourneyBoard, type ServiceGroup, type StageColumn, type SDCard } from '@/components/pipeline/journey-board'

export default async function PipelineOverviewPage() {
  const supabase = createClient()

  const [{ data: sds }, { data: pipelineStages }] = await Promise.all([
    supabase
      .from('service_deliveries')
      .select('id, service_type, stage, stage_order, stage_entered_at, account_id')
      .eq('status', 'active')
      .or('is_test.is.null,is_test.eq.false'),
    supabase
      .from('pipeline_stages')
      .select('service_type, stage_order, stage_name, sla_days')
      .order('service_type')
      .order('stage_order'),
  ])

  // Fetch account names for all unique account_ids
  const accountIds = Array.from(new Set((sds ?? []).map(sd => sd.account_id).filter(Boolean)))
  let accountMap: Record<string, string> = {}
  if (accountIds.length > 0) {
    const { data: accounts } = await supabase
      .from('accounts')
      .select('id, company_name')
      .in('id', accountIds)
    accountMap = Object.fromEntries((accounts ?? []).map(a => [a.id, a.company_name]))
  }

  const now = new Date()

  // stages map: serviceType → ordered array
  const stagesMap: Record<string, { stage_name: string; sla_days: number | null; stage_order: number }[]> = {}
  for (const ps of pipelineStages ?? []) {
    if (!ps.service_type) continue
    if (!stagesMap[ps.service_type]) stagesMap[ps.service_type] = []
    stagesMap[ps.service_type].push({
      stage_name: ps.stage_name,
      sla_days: ps.sla_days,
      stage_order: ps.stage_order,
    })
  }

  // group: serviceType → stageName → SDCard[]
  const grouped: Record<string, Record<string, SDCard[]>> = {}
  for (const sd of sds ?? []) {
    const type = sd.service_type
    const stage = sd.stage ?? '—'
    if (!type) continue
    if (!grouped[type]) grouped[type] = {}
    if (!grouped[type][stage]) grouped[type][stage] = []
    grouped[type][stage].push({
      id: sd.id,
      accountId: sd.account_id ?? '',
      companyName: sd.account_id ? (accountMap[sd.account_id] ?? 'Unknown') : 'No Account',
      daysAtStage: sd.stage_entered_at ? differenceInDays(now, new Date(sd.stage_entered_at)) : null,
    })
  }

  const serviceGroups: ServiceGroup[] = Object.entries(grouped)
    .map(([serviceType, stageCards]): ServiceGroup => {
      const orderedStages = stagesMap[serviceType] ?? []
      const knownNames = new Set(orderedStages.map(s => s.stage_name))
      const extraStages = Object.keys(stageCards)
        .filter(n => !knownNames.has(n))
        .map(n => ({ stage_name: n, sla_days: null as number | null, stage_order: 999 }))
      const allStages = [...orderedStages, ...extraStages]

      const stages: StageColumn[] = allStages.map(s => ({
        stageName: s.stage_name,
        slaDays: s.sla_days,
        cards: (stageCards[s.stage_name] ?? []).sort(
          (a, b) => (b.daysAtStage ?? 0) - (a.daysAtStage ?? 0),
        ),
      }))

      return {
        serviceType,
        trackerSlug: SERVICE_TYPE_TO_SLUG[serviceType] ?? null,
        totalActive: Object.values(stageCards).reduce((n, c) => n + c.length, 0),
        stages,
      }
    })
    .filter(g => g.totalActive > 0)
    .sort((a, b) => b.totalActive - a.totalActive)

  return (
    <div className="p-6 lg:p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Pipeline Overview</h1>
        <p className="text-muted-foreground text-sm mt-1">
          All active service deliveries across every pipeline — oldest cards surface first.
        </p>
      </div>
      <JourneyBoard groups={serviceGroups} />
    </div>
  )
}
