'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { CheckCircle2, Circle, ChevronRight, Loader2, AlertTriangle } from 'lucide-react'
import { advanceSDStage } from '@/app/(dashboard)/accounts/[id]/actions'

export interface PipelineStage {
  stage_name: string
  stage_order: number
}

interface SdPipelineStepperProps {
  deliveryId: string
  serviceType: string
  serviceName: string
  currentStage: string | null
  status: string
  updatedAt: string
  stages: PipelineStage[]
}

// Stages that are terminal bad-paths and never reachable from sequential
// click-advance — they're shown as a separate gray chip below the main flow
// and can only be set via the MCP tool (sd_advance_stage with explicit
// target_stage) or a future "Mark as terminated" action. Keeping this list
// explicit and short — it's easier to audit than a schema column.
const BAD_PATH_STAGE_NAMES = new Set<string>(['Terminated - Non Payment'])

export function SdPipelineStepper({
  deliveryId,
  serviceType,
  serviceName,
  currentStage,
  status,
  updatedAt,
  stages,
}: SdPipelineStepperProps) {
  const router = useRouter()
  const [confirmTarget, setConfirmTarget] = useState<PipelineStage | null>(null)
  const [isPending, startTransition] = useTransition()

  // Stable order: stage_order ascending, then stage_name alphabetical to
  // disambiguate duplicate stage_orders (Tax Return has dup orders).
  const sortedStages = [...stages].sort(
    (a, b) => a.stage_order - b.stage_order || a.stage_name.localeCompare(b.stage_name),
  )

  const flow = sortedStages.filter((s) => !BAD_PATH_STAGE_NAMES.has(s.stage_name))
  const badPaths = sortedStages.filter((s) => BAD_PATH_STAGE_NAMES.has(s.stage_name))

  const currentIdx = currentStage
    ? flow.findIndex((s) => s.stage_name === currentStage)
    : -1
  const isOnBadPath =
    currentStage !== null && BAD_PATH_STAGE_NAMES.has(currentStage)

  const isTerminalStatus = status === 'completed' || status === 'cancelled'
  const isOnHold = status === 'on_hold'

  const nextStage =
    !isTerminalStatus && !isOnHold && !isOnBadPath && currentIdx >= 0 && currentIdx < flow.length - 1
      ? flow[currentIdx + 1]
      : null

  function handleAdvance(target: PipelineStage) {
    startTransition(async () => {
      const result = await advanceSDStage(deliveryId, updatedAt, target.stage_name)
      if (!result.success) {
        toast.error(result.error ?? 'Failed to advance stage')
        setConfirmTarget(null)
        return
      }
      const triggers = result.auto_triggers ?? []
      const tasks = result.created_tasks ?? []
      const parts: string[] = []
      if (tasks.length) parts.push(`${tasks.length} task${tasks.length === 1 ? '' : 's'} created`)
      if (triggers.length) parts.push(...triggers)
      const detail = parts.length ? ` (${parts.join(', ')})` : ''
      toast.success(
        result.is_completed
          ? `${serviceName} completed${detail}`
          : `Advanced to ${result.to_stage}${detail}`,
      )
      setConfirmTarget(null)
      router.refresh()
    })
  }

  if (flow.length === 0) {
    return (
      <div className="text-xs text-zinc-500">
        No pipeline stages configured for {serviceType}.
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1 flex-wrap" data-testid="sd-stepper">
        {flow.map((s, idx) => {
          const isCurrent = s.stage_name === currentStage
          const isPast = currentIdx >= 0 && idx < currentIdx
          const isNext = nextStage?.stage_name === s.stage_name
          const isLast = idx === flow.length - 1
          const isClickable = isNext && !isPending

          const chipClass = isCurrent
            ? 'bg-blue-100 text-blue-900 border-blue-300 font-medium ring-1 ring-blue-300'
            : isPast || (isTerminalStatus && idx <= currentIdx)
              ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
              : isNext
                ? 'bg-white text-blue-700 border-blue-300 hover:bg-blue-50 cursor-pointer'
                : 'bg-zinc-50 text-zinc-400 border-zinc-200'

          return (
            <div key={`${s.stage_order}-${s.stage_name}`} className="flex items-center gap-1">
              <button
                type="button"
                disabled={!isClickable}
                onClick={() => setConfirmTarget(s)}
                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full border text-xs whitespace-nowrap transition-colors ${chipClass} ${
                  !isClickable ? 'cursor-default' : ''
                }`}
                title={
                  isNext
                    ? `Click to advance ${serviceName} to ${s.stage_name}`
                    : isCurrent
                      ? `Current stage`
                      : isPast
                        ? `Completed`
                        : `Upcoming`
                }
              >
                {isPast || (isTerminalStatus && idx <= currentIdx) ? (
                  <CheckCircle2 className="h-3 w-3" />
                ) : isCurrent ? (
                  <Circle className="h-3 w-3 fill-blue-600 text-blue-600" />
                ) : (
                  <Circle className="h-3 w-3" />
                )}
                <span>{s.stage_name}</span>
              </button>
              {!isLast && <ChevronRight className="h-3 w-3 text-zinc-300" />}
            </div>
          )
        })}
      </div>

      {badPaths.length > 0 && (
        <div className="flex items-center gap-2 pt-1">
          <span className="text-[10px] uppercase tracking-wide text-zinc-400">Off-flow:</span>
          {badPaths.map((s) => {
            const isHere = s.stage_name === currentStage
            return (
              <span
                key={s.stage_name}
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] ${
                  isHere
                    ? 'bg-amber-100 text-amber-900 border-amber-300 font-medium'
                    : 'bg-zinc-50 text-zinc-400 border-zinc-200'
                }`}
                title={`Terminal state — set via MCP tool only`}
              >
                <AlertTriangle className="h-3 w-3" />
                {s.stage_name}
              </span>
            )
          })}
        </div>
      )}

      {confirmTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={(e) => {
            if (e.target === e.currentTarget && !isPending) setConfirmTarget(null)
          }}
        >
          <div className="bg-white rounded-xl shadow-2xl p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-semibold mb-2">Advance pipeline?</h3>
            <p className="text-sm text-zinc-600 mb-4">
              Advance <span className="font-medium text-zinc-900">{serviceName}</span> from{' '}
              <span className="font-medium text-zinc-900">{currentStage ?? '—'}</span> to{' '}
              <span className="font-medium text-blue-700">{confirmTarget.stage_name}</span>?
            </p>
            <p className="text-xs text-zinc-500 mb-5">
              This will run auto-tasks, notify the client (if configured), and log to action history.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmTarget(null)}
                disabled={isPending}
                className="px-3 py-1.5 text-sm rounded-md border border-zinc-200 hover:bg-zinc-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => handleAdvance(confirmTarget)}
                disabled={isPending}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {isPending ? 'Advancing…' : 'Advance'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
