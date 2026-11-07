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
import { actionConfirmText } from '@/lib/flows/action-confirm'
import { actionTargetStage } from '@/lib/flows/action-target'

interface ActionButtonsProps {
  serviceDeliveryId: string
  /** Actions from stage_layout — bare keys ("approve") or advance_next objects. */
  actions?: StageAction[]
  /** The job belongs to a company of ours — a button may then ask a different (stronger) question before acting. */
  hasCompany?: boolean
}

type Variant = 'primary' | 'secondary'

interface ActionConfig {
  label: string
  busyLabel: string
  icon: React.ComponentType<{ className?: string }>
  variant: Variant
}

/**
 * stage_layout action key → button look. Each button POSTs to
 * /api/flows/[id]/advance with its target stage; advanceServiceDelivery owns the
 * side effects (stage_history, status/completion, portal notify). Unknown keys
 * are ignored so adding new actions to a layout never breaks the render.
 *
 * WHERE the button goes is `actionTargetStage` (lib/flows/action-target.ts): the stage layout's own `target` first, a fallback per key
 * second. It used to be hard-coded here with stage names the Tax Return pipeline does not have.
 *
 * Tax Return review/filing actions plus the AR/RA "complete" → "Closed" action
 * (the original behavior, preserved).
 */
const ACTION_CONFIG: Record<string, ActionConfig> = {
  start_review: {
    label: 'Start Review',
    busyLabel: 'Starting…',
    icon: PlayCircle,
    variant: 'primary',
  },
  approve: {
    label: 'Approve',
    busyLabel: 'Approving…',
    icon: CheckCircle2,
    variant: 'primary',
  },
  request_changes: {
    label: 'Request Changes',
    busyLabel: 'Requesting…',
    icon: RotateCcw,
    variant: 'secondary',
  },
  file_with_irs: {
    label: 'File with IRS',
    busyLabel: 'Filing…',
    icon: Landmark,
    variant: 'primary',
  },
  mark_completed: {
    label: 'Mark as Completed',
    busyLabel: 'Completing…',
    icon: Flag,
    variant: 'primary',
  },
  // AR / RA recurring renewal flows — original behavior.
  complete: {
    label: 'Mark as Completed',
    busyLabel: 'Completing…',
    icon: CheckCircle2,
    variant: 'primary',
  },
}

/** A render-ready action with a unique id, resolved label, and target stage. */
interface ResolvedAction extends ActionConfig {
  /** Stage to advance to via /api/flows/[id]/advance. */
  targetStage: string
  /** Unique id for busy-state keying (advance_next entries share one key, so we
   *  suffix the target to disambiguate multiple on one stage). */
  uid: string
  /** The question asked before acting (in the page, with Confirm / Cancel), or null = act at once. */
  confirmText: string | null
  /** The question is the "this closes the company" one: it also shows WHICH company and what goes with it (the closing brief). */
  askBrief: boolean
}

/** What the closing question shows under its sentence (GET /api/flows/[id]/closing-brief). */
interface ClosingBriefView {
  headline: string
  lines: string[]
  /** the wizard named a different company than the one the job is linked to — shown in red, and "finish without closing" is offered */
  warning: string | null
}

/**
 * Resolve a stage_layout action into a render-ready button.
 *  - string → looked up in ACTION_CONFIG (fixed transitions). Unknown → null.
 *  - { key:'advance_next', label, target } → a generic forward button to an
 *    explicit target stage, with the layout-supplied label. Missing target → null.
 *  - { key:'<known>', label?, target? } → ACTION_CONFIG look, the layout's target (else the key's fallback), optional label override.
 */
function resolveAction(action: StageAction, hasCompany: boolean): ResolvedAction | null {
  if (typeof action === 'string') {
    const config = ACTION_CONFIG[action]
    const targetStage = actionTargetStage(action)
    return config && targetStage ? { ...config, targetStage, uid: action, confirmText: null, askBrief: false } : null
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
      confirmText: actionConfirmText(action, hasCompany),
      askBrief: hasCompany && !!action.confirmCompany,
    }
  }
  const config = ACTION_CONFIG[action.key]
  const targetStage = actionTargetStage(action.key, action.target)
  if (!config || !targetStage) return null
  return { ...config, targetStage, uid: action.key, label: action.label ?? config.label, confirmText: actionConfirmText(action, hasCompany), askBrief: hasCompany && !!action.confirmCompany }
}

export function ActionButtons({ serviceDeliveryId, actions, hasCompany = false }: ActionButtonsProps) {
  const router = useRouter()
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [warning, setWarning] = useState<string | null>(null)
  // the button whose question is showing ("are you sure" panel); an in-page panel, not window.confirm (blocked in some browsers)
  const [askingUid, setAskingUid] = useState<string | null>(null)
  // the closing brief of the question that is showing: undefined = not asked / not needed, 'loading', or the lines (null = could not be read)
  const [brief, setBrief] = useState<ClosingBriefView | 'loading' | null | undefined>(undefined)

  const resolved = (actions ?? [])
    .map((a) => resolveAction(a, hasCompany))
    .filter((a): a is ResolvedAction => a !== null)
  if (resolved.length === 0) return null

  /** Open the question; for the "closes the company" one, also read which company and what goes with it. */
  async function askQuestion(action: ResolvedAction) {
    setError(null)
    setAskingUid(action.uid)
    if (!action.askBrief) { setBrief(undefined); return }
    setBrief('loading')
    try {
      const res = await fetch(`/api/flows/${serviceDeliveryId}/closing-brief`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) throw new Error(data.error || 'Could not read the company.')
      setBrief(data.brief ? { headline: data.headline, lines: data.lines ?? [], warning: data.warning ?? null } : null)
    } catch {
      setBrief(null)
    }
  }

  async function runAction(action: ResolvedAction, opts?: { skipCompanyClose?: boolean }) {
    if (busyKey) return
    setAskingUid(null)
    setBusyKey(action.uid)
    setError(null)
    setWarning(null)
    try {
      const res = await fetch(`/api/flows/${serviceDeliveryId}/advance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_stage: action.targetStage, ...(opts?.skipCompanyClose ? { skip_company_close: true } : {}) }),
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
              onClick={() => (action.confirmText ? askQuestion(action) : runAction(action))}
              disabled={disabled}
              data-guide-action={action.targetStage}
              className={`${base} ${styles}`}
            >
              {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4" />}
              {isBusy ? action.busyLabel : action.label}
            </button>
          )
        })}
      </div>
      {resolved.map((action) =>
        askingUid === action.uid && action.confirmText ? (
          <div key={`ask-${action.uid}`} className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-3 text-sm text-amber-900">
            <p>{action.confirmText}</p>
            {action.askBrief && brief === 'loading' && <p className="mt-2 text-amber-700">Checking the company…</p>}
            {action.askBrief && brief && brief !== 'loading' && (
              <div className="mt-2">
                <p className="font-semibold">{brief.headline}</p>
                {brief.lines.length > 0 && (
                  <ul className="mt-1 list-disc space-y-0.5 pl-5">
                    {brief.lines.map((line) => <li key={line}>{line}</li>)}
                  </ul>
                )}
                {brief.warning && (
                  <p className="mt-2 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-red-800">
                    <span className="font-semibold">Check before you answer:</span> {brief.warning}
                  </p>
                )}
              </div>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => runAction(action)}
                disabled={busyKey !== null || (action.askBrief && brief === 'loading')}
                className="inline-flex cursor-pointer items-center gap-2 rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-zinc-200 disabled:text-zinc-400"
              >
                Yes, confirm
              </button>
              {action.askBrief && brief && brief !== 'loading' && brief.warning && (
                <button
                  type="button"
                  onClick={() => runAction(action, { skipCompanyClose: true })}
                  disabled={busyKey !== null}
                  className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed"
                >
                  Finish the job without closing the company
                </button>
              )}
              <button
                type="button"
                onClick={() => setAskingUid(null)}
                disabled={busyKey !== null}
                className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null,
      )}
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      {warning && (
        <p className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {warning}
        </p>
      )}
    </div>
  )
}
