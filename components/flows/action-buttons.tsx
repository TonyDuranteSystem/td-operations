'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
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
import { REVIEW_REQUESTS_CHANGED_EVENT } from '@/lib/flows/review-requests-event'
import { ClosingQuestion } from '@/components/flows/closing-question'
import { FLOW_DOC_UPLOADED_EVENT, type FlowDocUploadedDetail } from '@/components/flows/document-upload'
import { FLOW_TRACKING_SAVED_EVENT, type FlowTrackingSavedDetail } from '@/lib/flows/tracking-saved-event'

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

  // A refusal ("A document must be uploaded…", "Save the tracking number…") is stale once the document is uploaded or the number saved — drop the
  // red line then instead of leaving it until the next click (production end-to-end test 2026-11-07).
  useEffect(() => {
    function clearIfMine(e: Event) {
      const detail = (e as CustomEvent<FlowDocUploadedDetail | FlowTrackingSavedDetail>).detail
      if (!detail || detail.serviceDeliveryId === serviceDeliveryId) setError(null)
    }
    window.addEventListener(FLOW_DOC_UPLOADED_EVENT, clearIfMine)
    window.addEventListener(FLOW_TRACKING_SAVED_EVENT, clearIfMine)
    return () => {
      window.removeEventListener(FLOW_DOC_UPLOADED_EVENT, clearIfMine)
      window.removeEventListener(FLOW_TRACKING_SAVED_EVENT, clearIfMine)
    }
  }, [serviceDeliveryId])

  // Requests staff wrote next to answers (review screen) but have not sent: "Request Changes (2)", and Approve asks first.
  const hasRequestChanges = (actions ?? []).some((a) => (typeof a === 'string' ? a : a.key) === 'request_changes')
  const [requestCount, setRequestCount] = useState(0)
  useEffect(() => {
    if (!hasRequestChanges) return
    let cancelled = false
    fetch(`/api/flows/${serviceDeliveryId}/review-notes`, { cache: 'no-store' })
      .then((r) => r.json().catch(() => ({})))
      .then((d) => { if (!cancelled && d?.success && typeof d.count === 'number') setRequestCount(d.count) })
      .catch(() => { /* the count is a convenience; the button still works without it */ })
    const onChanged = (e: Event) => {
      const detail = (e as CustomEvent<{ serviceDeliveryId?: string; count?: number }>).detail
      if (detail?.serviceDeliveryId === serviceDeliveryId && typeof detail.count === 'number') setRequestCount(detail.count)
    }
    window.addEventListener(REVIEW_REQUESTS_CHANGED_EVENT, onChanged)
    return () => {
      cancelled = true
      window.removeEventListener(REVIEW_REQUESTS_CHANGED_EVENT, onChanged)
    }
  }, [hasRequestChanges, serviceDeliveryId])

  const resolved = (actions ?? [])
    .map((a) => resolveAction(a, hasCompany))
    .filter((a): a is ResolvedAction => a !== null)
    .map((a) => {
      if (requestCount <= 0) return a
      if (a.uid === 'request_changes') return { ...a, label: `${a.label} (${requestCount})` }
      if (a.uid === 'approve') {
        const n = requestCount === 1 ? '1 request' : `${requestCount} requests`
        return { ...a, confirmText: `You wrote ${n} next to the client's answers that ${requestCount === 1 ? 'has' : 'have'} not been sent. Approve anyway? Approving locks the answers and ${requestCount === 1 ? 'it' : 'they'} will not be sent.` }
      }
      return a
    })
  if (resolved.length === 0) return null

  /** Open the question. The "closes the company" one reads which company and what goes with it itself (components/flows/closing-question.tsx). */
  function askQuestion(action: ResolvedAction) {
    setError(null)
    setAskingUid(action.uid)
  }

  async function runAction(action: ResolvedAction, opts?: { skipCompanyClose?: boolean; companyCloseConfirmed?: boolean }) {
    if (busyKey) return
    setAskingUid(null)
    setBusyKey(action.uid)
    setError(null)
    setWarning(null)
    try {
      const res = await fetch(`/api/flows/${serviceDeliveryId}/advance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_stage: action.targetStage, ...(opts?.skipCompanyClose ? { skip_company_close: true } : {}), ...(opts?.companyCloseConfirmed ? { company_close_confirmed: true } : {}) }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Could not perform this action. Please try again.')
      }
      // The action succeeded, but a follow-on step (e.g. unlocking the client's
      // tax form) may need staff attention — show it without blocking.
      if (typeof data.warning === 'string' && data.warning) {
        setWarning(data.warning)
        // The refresh below moves the job to its next step, where this button is gone — and the inline line with it (live test 2026-11-08: a closing
        // problem flashed and vanished). A toast outlives the refresh; the server also wrote the closing problems on the job.
        toast.warning(data.warning, { duration: 30000 })
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
          action.askBrief ? (
            <ClosingQuestion
              key={`ask-${action.uid}`}
              serviceDeliveryId={serviceDeliveryId}
              question={action.confirmText}
              busy={busyKey !== null}
              onConfirm={(o) => runAction(action, { skipCompanyClose: o?.skipCompanyClose, companyCloseConfirmed: true })}
              onCancel={() => setAskingUid(null)}
            />
          ) : (
            <div key={`ask-${action.uid}`} className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-3 text-sm text-amber-900">
              <p>{action.confirmText}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => runAction(action)}
                  disabled={busyKey !== null}
                  className="inline-flex cursor-pointer items-center gap-2 rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-zinc-200 disabled:text-zinc-400"
                >
                  Yes, confirm
                </button>
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
          )
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
