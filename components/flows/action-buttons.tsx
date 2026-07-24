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
  ArrowRight,
} from 'lucide-react'
import type { StageAction } from '@/lib/flows/stage-layout'

interface ActionButtonsProps {
  serviceDeliveryId: string
  /** Actions from stage_layout — bare keys ("approve") or advance_next objects. */
  actions?: StageAction[]
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

/** A render-ready action with a unique id, resolved label, and target stage. */
interface ResolvedAction extends ActionConfig {
  /** Unique id for busy-state keying (advance_next entries share one key, so we
   *  suffix the target to disambiguate multiple on one stage). */
  uid: string
}

/**
 * Resolve a stage_layout action into a render-ready button.
 *  - string → looked up in ACTION_CONFIG (fixed transitions). Unknown → null.
 *  - { key:'advance_next', label, target } → a generic forward button to an
 *    explicit target stage, with the layout-supplied label. Missing target → null.
 *  - { key:'<known>', label? } → ACTION_CONFIG entry, with optional label override.
 */
function resolveAction(action: StageAction): ResolvedAction | null {
  if (typeof action === 'string') {
    const config = ACTION_CONFIG[action]
    return config ? { ...config, uid: action } : null
  }
  if (action.key === 'advance_next') {
    if (!action.target) return null
    return {
      uid: `advance_next:${action.target}`,
      targetStage: action.target,
      label: action.label ?? 'Advance to Next Stage',
      busyLabel: 'Advancing…',
      icon: ArrowRight,
      variant: 'primary',
    }
  }
  const config = ACTION_CONFIG[action.key]
  if (!config) return null
  return { ...config, uid: action.key, label: action.label ?? config.label }
}

export function ActionButtons({ serviceDeliveryId, actions }: ActionButtonsProps) {
  const router = useRouter()
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [warning, setWarning] = useState<string | null>(null)

  const resolved = (actions ?? [])
    .map(resolveAction)
    .filter((a): a is ResolvedAction => a !== null)
  if (resolved.length === 0) return null

  async function runAction(action: ResolvedAction) {
    if (busyKey) return
    setBusyKey(action.uid)
    setError(null)
    setWarning(null)
    try {
      const res = await fetch(`/api/flows/${serviceDeliveryId}/advance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_stage: action.targetStage }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Could not perform this action. Please try again.')
      }
      // The action succeeded, but a follow-on step (e.g. unlocking the client's
      // tax form) may need staff attention — show it without blocking.
      if (typeof data.warning === 'string' && data.warning) setWarning(data.warning)
      router.refresh()
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not perform this action.')
      setBusyKey(null)
    }
  }

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <div className="flex flex-wrap gap-2">
        {resolved.map((action) => {
          const Icon = action.icon
          const isBusy = busyKey === action.uid
          const disabled = busyKey !== null
          const base =
            'inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors'
          const styles = disabled
            ? action.variant === 'secondary'
              ? 'cursor-not-allowed border border-zinc-200 text-zinc-400'
              : 'cursor-not-allowed bg-zinc-200 text-zinc-400'
            : action.variant === 'secondary'
              ? 'cursor-pointer border border-amber-300 bg-white text-amber-700 hover:bg-amber-50'
              : 'cursor-pointer bg-emerald-600 text-white hover:bg-emerald-700'
          return (
            <button
              key={action.uid}
              type="button"
              onClick={() => runAction(action)}
              disabled={disabled}
              className={`${base} ${styles}`}
            >
              {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4" />}
              {isBusy ? action.busyLabel : action.label}
            </button>
          )
        })}
      </div>
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      {warning && (
        <p className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {warning}
        </p>
      )}
    </div>
  )
}
