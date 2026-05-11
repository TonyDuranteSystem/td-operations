'use client'

import { Workflow } from 'lucide-react'
import { SdPipelineStepper, type PipelineStage } from './sd-pipeline-stepper'

export interface ServiceDeliveryForStepper {
  id: string
  service_type: string
  service_name: string
  stage: string | null
  stage_order: number | null
  status: string
  updated_at: string
  account_id: string | null
  contact_id: string | null
}

interface ServiceDeliveriesSectionProps {
  deliveries: ServiceDeliveryForStepper[]
  /** Map of service_type -> sorted stages from pipeline_stages. */
  stagesByServiceType: Record<string, PipelineStage[]>
  title?: string
  emptyMessage?: string
}

export function ServiceDeliveriesSection({
  deliveries,
  stagesByServiceType,
  title = 'Service Deliveries',
  emptyMessage = 'No active service deliveries.',
}: ServiceDeliveriesSectionProps) {
  const active = deliveries.filter(
    (d) => d.status !== 'completed' && d.status !== 'cancelled',
  )

  if (active.length === 0) {
    return (
      <div className="rounded-xl border border-zinc-200 bg-white p-5">
        <div className="flex items-center gap-2 mb-3">
          <Workflow className="h-4 w-4 text-zinc-500" />
          <h2 className="font-semibold text-zinc-900">{title}</h2>
        </div>
        <p className="text-sm text-zinc-500">{emptyMessage}</p>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-5">
      <div className="flex items-center gap-2 mb-4">
        <Workflow className="h-4 w-4 text-zinc-500" />
        <h2 className="font-semibold text-zinc-900">{title}</h2>
        <span className="text-xs text-zinc-500">
          {active.length} active
        </span>
      </div>
      <div className="space-y-4">
        {active.map((d) => {
          const stages = stagesByServiceType[d.service_type] ?? []
          return (
            <div
              key={d.id}
              className="border border-zinc-100 rounded-lg p-3 bg-zinc-50/40"
            >
              <div className="flex items-baseline justify-between gap-2 mb-2">
                <div className="flex items-baseline gap-2 min-w-0">
                  <span className="font-medium text-zinc-900 truncate">
                    {d.service_name || d.service_type}
                  </span>
                  <span className="text-xs text-zinc-500">{d.service_type}</span>
                </div>
                {d.status === 'on_hold' && (
                  <span className="text-[11px] uppercase tracking-wide px-2 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-200">
                    On hold
                  </span>
                )}
              </div>
              <SdPipelineStepper
                deliveryId={d.id}
                serviceType={d.service_type}
                serviceName={d.service_name || d.service_type}
                currentStage={d.stage}
                status={d.status}
                updatedAt={d.updated_at}
                stages={stages}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
