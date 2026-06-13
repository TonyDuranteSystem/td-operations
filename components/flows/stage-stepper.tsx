import { CheckCircle2, Circle, ChevronRight } from 'lucide-react'

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
}

/**
 * Read-only horizontal stepper for a flow Workspace. Shows every stage of the
 * service_type in order: past stages get a checkmark, the current stage is
 * highlighted, future stages are dimmed. Not clickable — stages advance via
 * actions, never by clicking the stepper.
 */
export function StageStepper({ stages, currentStage }: StageStepperProps) {
  const sorted = [...stages].sort(
    (a, b) => a.stage_order - b.stage_order || a.stage_name.localeCompare(b.stage_name),
  )

  const currentIdx = currentStage ? sorted.findIndex((s) => s.stage_name === currentStage) : -1

  if (sorted.length === 0) {
    return <div className="text-xs text-zinc-500">No stages configured for this flow.</div>
  }

  return (
    <div className="flex items-center gap-1 flex-wrap" data-testid="flow-stage-stepper">
      {sorted.map((s, idx) => {
        const isCurrent = idx === currentIdx
        const isPast = currentIdx >= 0 && idx < currentIdx
        const isLast = idx === sorted.length - 1

        const chipClass = isCurrent
          ? 'bg-blue-100 text-blue-900 border-blue-300 font-medium ring-1 ring-blue-300'
          : isPast
            ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
            : 'bg-zinc-50 text-zinc-400 border-zinc-200'

        return (
          <div key={`${s.stage_order}-${s.stage_name}`} className="flex items-center gap-1">
            <div
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full border text-xs whitespace-nowrap ${chipClass}`}
              title={s.client_label ?? s.stage_name}
            >
              {s.icon ? (
                <span aria-hidden>{s.icon}</span>
              ) : isPast ? (
                <CheckCircle2 className="h-3 w-3" />
              ) : isCurrent ? (
                <Circle className="h-3 w-3 fill-blue-600 text-blue-600" />
              ) : (
                <Circle className="h-3 w-3" />
              )}
              <span>{s.stage_name}</span>
            </div>
            {!isLast && <ChevronRight className="h-3 w-3 text-zinc-300" />}
          </div>
        )
      })}
    </div>
  )
}
