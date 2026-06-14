import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { parseStageLayout } from '@/lib/flows/stage-layout'
import { deriveFlowYear } from '@/lib/flows/resolve-flows'
import { StageStepper, type StepperStage } from '@/components/flows/stage-stepper'
import { StageRenderer } from '@/components/flows/stage-renderer'
import type { WorkspaceServiceDelivery, WorkspaceAccount } from '@/components/flows/types'

export const dynamic = 'force-dynamic'

/**
 * Flow Workspace — full page for a single service_delivery. The [id] is a
 * service_delivery_id. The stage's UI is driven by pipeline_stages.stage_layout
 * for the SD's current stage (matched by stage NAME, since stage_order on the SD
 * is frequently NULL).
 */
export default async function FlowWorkspacePage({ params }: { params: { id: string } }) {
  const { data: sd } = await supabaseAdmin
    .from('service_deliveries')
    .select('id, service_type, stage, stage_order, status, assigned_to, due_date, stage_entered_at, created_at, account_id')
    .eq('id', params.id)
    .single()

  if (!sd || !sd.service_type) notFound()

  const [{ data: accountRow }, { data: stageRows }] = await Promise.all([
    sd.account_id
      ? supabaseAdmin.from('accounts').select('id, company_name, state_of_formation, annual_report_due_date, ra_renewal_date').eq('id', sd.account_id).single()
      : Promise.resolve({ data: null }),
    supabaseAdmin
      .from('pipeline_stages')
      .select('stage_name, stage_order, icon, client_label, stage_layout')
      .eq('service_type', sd.service_type)
      .order('stage_order', { ascending: true }),
  ])

  // Cast via unknown: stage_layout was added by the S0 migration but the
  // generated DB types haven't been regenerated yet (gen:types pending).
  const stages = (stageRows ?? []) as unknown as Array<{
    stage_name: string
    stage_order: number
    icon: string | null
    client_label: string | null
    stage_layout: unknown
  }>

  // Match the current stage by NAME (SD.stage_order is often NULL/stale).
  const currentStageRow = stages.find((s) => s.stage_name === sd.stage) ?? null
  const layout = parseStageLayout(currentStageRow?.stage_layout)
  const year = deriveFlowYear(sd)

  const account: WorkspaceAccount = {
    id: (accountRow?.id as string) ?? sd.account_id ?? '',
    company_name: (accountRow?.company_name as string | null) ?? null,
    state_of_formation: (accountRow?.state_of_formation as string | null) ?? null,
    annual_report_due_date: (accountRow?.annual_report_due_date as string | null) ?? null,
    ra_renewal_date: (accountRow?.ra_renewal_date as string | null) ?? null,
  }

  const serviceDelivery: WorkspaceServiceDelivery = {
    id: sd.id,
    service_type: sd.service_type,
    stage: sd.stage ?? null,
    stage_order: sd.stage_order ?? null,
    status: sd.status ?? null,
    assigned_to: sd.assigned_to ?? null,
    due_date: sd.due_date ?? null,
    stage_entered_at: sd.stage_entered_at ?? null,
    account_id: sd.account_id ?? '',
    current_client_label: currentStageRow?.client_label ?? null,
  }

  const stepperStages: StepperStage[] = stages.map((s) => ({
    stage_name: s.stage_name,
    stage_order: s.stage_order,
    icon: s.icon,
    client_label: s.client_label,
  }))

  return (
    <div className="p-6 lg:p-8 max-w-5xl mx-auto">
      {/* Back link */}
      {account.id && (
        <Link
          href={`/accounts/${account.id}`}
          className="inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-800 mb-4"
        >
          <ArrowLeft className="h-4 w-4" />
          {account.company_name ?? 'Account'}
        </Link>
      )}

      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-zinc-900">
          {serviceDelivery.service_type}
          {year ? <span className="text-zinc-400"> {year}</span> : null}
        </h1>
        <p className="text-sm text-zinc-500 mt-0.5">
          {account.company_name ?? '—'}
          {serviceDelivery.status && (
            <span className="ml-2 rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] text-zinc-600">
              {serviceDelivery.status}
            </span>
          )}
        </p>
      </div>

      {/* Stage stepper */}
      <div className="mb-6 overflow-x-auto pb-1">
        <StageStepper stages={stepperStages} currentStage={serviceDelivery.stage} />
      </div>

      {/* Stage content from stage_layout */}
      <StageRenderer layout={layout} serviceDelivery={serviceDelivery} account={account} />
    </div>
  )
}
