'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  CheckCircle2,
  Loader2,
  PlayCircle,
  RotateCcw,
  Landmark,
  Flag,
} from 'lucide-react'

interface ActionButtonsProps {
  serviceDeliveryId: string
  /** Action keys from stage_layout (e.g. ["approve", "request_changes"]). */
  actions?: string[]
}

type Variant = 'primary' | 'secondary'

interface ActionConfig {
  /** Stage to advance to via /api/flows/[id]/advance. */
  targetStage: string
  label: string
  busyLabel: string
  icon: React.ComponentType<{ className?: string }>
  variant: Variant
}

/**
 * stage_layout action key → stage transition. Each button POSTs to
 * /api/flows/[id]/advance with the target stage; advanceServiceDelivery owns the
 * side effects (stage_history, status/completion, portal notify). Unknown keys
 * are ignored so adding new actions to a layout never breaks the render.
 *
 * Tax Return review/filing actions plus the AR/RA "complete" → "Closed" action
 * (the original behavior, preserved).
 */
const ACTION_CONFIG: Record<string, ActionConfig> = {
  start_review: {
    targetStage: 'Under Review',
    label: 'Start Review',
    busyLabel: 'Starting…',
    icon: PlayCircle,
    variant: 'primary',
  },
  approve: {
    targetStage: 'Review Completed',
    label: 'Approve',
    busyLabel: 'Approving…',
    icon: CheckCircle2,
    variant: 'primary',
  },
  request_changes: {
    targetStage: 'Revision Requested',
    label: 'Request Changes',
    busyLabel: 'Requesting…',
    icon: RotateCcw,
    variant: 'secondary',
  },
  file_with_irs: {
    targetStage: 'Filed with IRS',
    label: 'File with IRS',
    busyLabel: 'Filing…',
    icon: Landmark,
    variant: 'primary',
  },
  mark_completed: {
    targetStage: 'Completed',
    label: 'Mark as Completed',
    busyLabel: 'Completing…',
    icon: Flag,
    variant: 'primary',
  },
  // AR / RA recurring renewal flows — original behavior.
  complete: {
    targetStage: 'Closed',
    label: 'Mark as Completed',
    busyLabel: 'Completing…',
    icon: CheckCircle2,
    variant: 'primary',
  },
}

export function ActionButtons({ serviceDeliveryId, actions }: ActionButtonsProps) {
  const router = useRouter()
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const validActions = (actions ?? []).filter((a) => a in ACTION_CONFIG)
  if (validActions.length === 0) return null

  async function runAction(actionKey: string) {
    if (busyKey) return
    const config = ACTION_CONFIG[actionKey]
    setBusyKey(actionKey)
    setError(null)
    try {
      const res = await fetch(`/api/flows/${serviceDeliveryId}/advance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_stage: config.targetStage }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Could not perform this action. Please try again.')
      }
      router.refresh()
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not perform this action.')
      setBusyKey(null)
    }
  }

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <div className="flex flex-wrap gap-2">
        {validActions.map((actionKey) => {
          const config = ACTION_CONFIG[actionKey]
          const Icon = config.icon
          const isBusy = busyKey === actionKey
          const disabled = busyKey !== null
          const base =
            'inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors'
          const styles = disabled
            ? config.variant === 'secondary'
              ? 'cursor-not-allowed border border-zinc-200 text-zinc-400'
              : 'cursor-not-allowed bg-zinc-200 text-zinc-400'
            : config.variant === 'secondary'
              ? 'cursor-pointer border border-amber-300 bg-white text-amber-700 hover:bg-amber-50'
              : 'cursor-pointer bg-emerald-600 text-white hover:bg-emerald-700'
          return (
            <button
              key={actionKey}
              type="button"
              onClick={() => runAction(actionKey)}
              disabled={disabled}
              className={`${base} ${styles}`}
            >
              {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4" />}
              {isBusy ? config.busyLabel : config.label}
            </button>
          )
        })}
      </div>
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
    </div>
  )
}
