'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { CheckCircle2, Circle, ChevronRight, Loader2 } from 'lucide-react'

export interface StepperStage {
  stage_name: string
  stage_order: number
  icon?: string | null
  client_label?: string | null
}

interface StageStepperProps {
  stages: StepperStage[]
  /** Current stage matched by NAME (stage_order on the SD is often NULL/stale). */
  currentStage: string | null
  /** SD id — enables clicking a stage to move the SD there. */
  serviceDeliveryId: string
}

/**
 * Clickable horizontal stepper for a flow Workspace. Shows every stage of the
 * service_type in order: past stages get a checkmark, the current stage is
 * highlighted, future stages are dimmed.
 *
 * Clicking any stage (other than the current one) moves the SD to that stage —
 * forward or backward — via POST /api/flows/[id]/set-stage, after a confirm.
 * This is a SHORTCUT for the action buttons + Go Back: it fires the FULL side
 * effects (forward → auto-tasks + client notification + completion/renewal bump;
 * backward → deletes the re-opened stages' documents + undoes the renewal bump)
 * via moveServiceDeliveryToStage. Surfaces the server's real error (R099).
 */
export function StageStepper({ stages, currentStage, serviceDeliveryId }: StageStepperProps) {
  const router = useRouter()
  const [busyStage, setBusyStage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const sorted = [...stages].sort(
    (a, b) => a.stage_order - b.stage_order || a.stage_name.localeCompare(b.stage_name),
  )

  const currentIdx = currentStage ? sorted.findIndex((s) => s.stage_name === currentStage) : -1

  if (sorted.length === 0) {
    return <div className="text-xs text-zinc-500">No stages configured for this flow.</div>
  }

  async function moveTo(stage: StepperStage) {
    if (busyStage || stage.stage_name === currentStage) return
    const confirmed = window.confirm(`Move to ${stage.stage_name}?`)
    if (!confirmed) return

    setBusyStage(stage.stage_name)
    setError(null)
    try {
      const res = await fetch(`/api/flows/${serviceDeliveryId}/set-stage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_stage: stage.stage_name }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Could not move to this stage. Please try again.')
      }
      router.refresh()
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not move to this stage.')
    } finally {
      setBusyStage(null)
    }
  }

  return (
    <div>
      <div className="flex items-center gap-1 flex-wrap" data-testid="flow-stage-stepper">
        {sorted.map((s, idx) => {
          const isCurrent = idx === currentIdx
          const isPast = currentIdx >= 0 && idx < currentIdx
          const isLast = idx === sorted.length - 1
          const isBusy = busyStage === s.stage_name

          const chipClass = isCurrent
            ? 'bg-blue-100 text-blue-900 border-blue-300 font-medium ring-1 ring-blue-300'
            : isPast
              ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
              : 'bg-zinc-50 text-zinc-400 border-zinc-200'

          // The current stage is not clickable (it's where we already are).
          const interactive = !isCurrent && !busyStage
          const hoverClass = isCurrent
            ? 'cursor-default'
            : busyStage
              ? 'cursor-not-allowed opacity-60'
              : 'cursor-pointer hover:ring-1 hover:ring-blue-300 hover:border-blue-300'

          return (
            <div key={`${s.stage_order}-${s.stage_name}`} className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => moveTo(s)}
                disabled={!interactive}
                aria-current={isCurrent ? 'step' : undefined}
                title={isCurrent ? (s.client_label ?? s.stage_name) : `Move to ${s.stage_name}`}
                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full border text-xs whitespace-nowrap transition-all ${chipClass} ${hoverClass}`}
              >
                {isBusy ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : s.icon ? (
                  <span aria-hidden>{s.icon}</span>
                ) : isPast ? (
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
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  )
}
