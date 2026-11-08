'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  CheckCircle2, Circle, ChevronRight, Loader2,
  ClipboardCheck, CreditCard, FileCheck, FileSignature, Landmark, Send,
  type LucideIcon,
} from 'lucide-react'
import { FastTooltip } from '@/components/ui/fast-tooltip'
import { FLOW_DOC_UPLOADED_EVENT, type FlowDocUploadedDetail } from './document-upload'
import { ClosingQuestion } from './closing-question'
import { STEP_BAR_CLOSE_QUESTION } from '@/lib/closure/closing-step'
import { FLOW_TRACKING_SAVED_EVENT, type FlowTrackingSavedDetail } from '@/lib/flows/tracking-saved-event'
import { useGoBackWarnings } from './use-go-back-warnings'

export interface StepperStage {
  stage_name: string
  stage_order: number
  icon?: string | null
  client_label?: string | null
}

/**
 * pipeline_stages.icon holds EITHER an emoji (older flows: "📄", "✅", …) OR a
 * Lucide component NAME (Company Formation v2: "CreditCard", "Landmark", …).
 * Emojis render fine as text; the Lucide names must map to a component, else the
 * raw string "CreditCard" shows in the stepper. Only the names actually used by
 * formation are mapped — anything else falls through to the emoji/text branch.
 */
const STAGE_ICONS: Record<string, LucideIcon> = {
  CheckCircle2,
  ClipboardCheck,
  CreditCard,
  FileCheck,
  FileSignature,
  Landmark,
  Send,
}

interface StageStepperProps {
  stages: StepperStage[]
  /** Current stage matched by NAME (stage_order on the SD is often NULL/stale). */
  currentStage: string | null
  /** SD id — enables clicking a stage to move the SD there. */
  serviceDeliveryId: string
  /** The name of the step whose forward move CLOSES a company (Company Closure with a company: "Closing"), else null. Moving there asks the
   *  in-page "this closes the company" question — which company, what goes with it — instead of the bare browser prompt. */
  closesCompanyAt?: string | null
  /** What a move BACK also does here (deletes the saved IRS tracking number, a closed company stays Closed) — said in the move's question, like Go Back's.
   *  The step bar moved back over a saved tracking number with a bare "Move to …?" and deleted it without a word (live test 2026-11-08). */
  backWarnings?: string[]
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
export function StageStepper({ stages, currentStage, serviceDeliveryId, closesCompanyAt = null, backWarnings }: StageStepperProps) {
  const router = useRouter()
  const moveBackLines = useGoBackWarnings(serviceDeliveryId, backWarnings)
  const [busyStage, setBusyStage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // the step whose "this closes the company" question is open
  const [askingStage, setAskingStage] = useState<StepperStage | null>(null)

  // A refusal ("A document must be uploaded on …") is stale once a document is uploaded for this job or the job has
  // moved — clear it then, instead of leaving the red line on screen until the next click (N1a C2).
  useEffect(() => {
    function onUploaded(e: Event) {
      const detail = (e as CustomEvent<FlowDocUploadedDetail>).detail
      if (!detail || detail.serviceDeliveryId === serviceDeliveryId) setError(null)
    }
    function onTrackingSaved(e: Event) {
      const detail = (e as CustomEvent<FlowTrackingSavedDetail>).detail
      if (!detail || detail.serviceDeliveryId === serviceDeliveryId) setError(null)
    }
    window.addEventListener(FLOW_DOC_UPLOADED_EVENT, onUploaded)
    window.addEventListener(FLOW_TRACKING_SAVED_EVENT, onTrackingSaved)
    return () => {
      window.removeEventListener(FLOW_DOC_UPLOADED_EVENT, onUploaded)
      window.removeEventListener(FLOW_TRACKING_SAVED_EVENT, onTrackingSaved)
    }
  }, [serviceDeliveryId])
  useEffect(() => {
    setError(null)
    setAskingStage(null)
  }, [currentStage])

  const sorted = [...stages].sort(
    (a, b) => a.stage_order - b.stage_order || a.stage_name.localeCompare(b.stage_name),
  )

  const currentIdx = currentStage ? sorted.findIndex((s) => s.stage_name === currentStage) : -1

  if (sorted.length === 0) {
    return <div className="text-xs text-zinc-500">No stages configured for this flow.</div>
  }

  function moveTo(stage: StepperStage) {
    if (busyStage || stage.stage_name === currentStage) return
    // A forward move that CLOSES the company asks the real question in the page (which company, what goes with it); everything else keeps the
    // simple browser prompt.
    if (closesCompanyAt && stage.stage_name === closesCompanyAt && stage.stage_order > (sorted[currentIdx]?.stage_order ?? -1)) {
      setError(null)
      setAskingStage(stage)
      return
    }
    const movingBack = stage.stage_order < (sorted[currentIdx]?.stage_order ?? Number.POSITIVE_INFINITY)
    const confirmed = window.confirm([`Move to ${stage.stage_name}?`, ...(movingBack ? moveBackLines : [])].join('\n\n'))
    if (!confirmed) return
    void doMove(stage)
  }

  async function doMove(stage: StepperStage, opts?: { skipCompanyClose?: boolean; companyCloseConfirmed?: boolean }) {
    setAskingStage(null)
    setBusyStage(stage.stage_name)
    setError(null)
    try {
      const res = await fetch(`/api/flows/${serviceDeliveryId}/set-stage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target_stage: stage.stage_name,
          ...(opts?.skipCompanyClose ? { skip_company_close: true } : {}),
          ...(opts?.companyCloseConfirmed ? { company_close_confirmed: true } : {}),
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Could not move to this stage. Please try again.')
      }
      // What the move did besides moving: a move back deletes the saved IRS tracking number / leaves a closed company Closed; a finish may not have closed
      // the company fully. A toast survives the refresh below (an inline line would be gone with it) — and the server also wrote the closing problems on the job.
      for (const w of (data.warnings ?? []) as string[]) toast.warning(w, { duration: 12000 })
      if (data.warning) toast.warning(data.warning as string, { duration: 30000 })
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
              <FastTooltip label={isCurrent ? (s.client_label ?? s.stage_name) : `Move to ${s.stage_name}`}>
                <button
                  type="button"
                  onClick={() => moveTo(s)}
                  disabled={!interactive}
                  aria-current={isCurrent ? 'step' : undefined}
                  aria-label={isCurrent ? (s.client_label ?? s.stage_name) : `Move to ${s.stage_name}`}
                  className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full border text-xs whitespace-nowrap transition-all ${chipClass} ${hoverClass}`}
                >
                  {isBusy ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : s.icon && STAGE_ICONS[s.icon] ? (
                    (() => {
                      const Ic = STAGE_ICONS[s.icon as string]
                      return <Ic className="h-3 w-3" aria-hidden />
                    })()
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
              </FastTooltip>
              {!isLast && <ChevronRight className="h-3 w-3 text-zinc-300" />}
            </div>
          )
        })}
      </div>
      {askingStage && (
        <ClosingQuestion
          serviceDeliveryId={serviceDeliveryId}
          question={STEP_BAR_CLOSE_QUESTION}
          busy={busyStage !== null}
          onConfirm={(o) => void doMove(askingStage, { skipCompanyClose: o?.skipCompanyClose, companyCloseConfirmed: true })}
          onCancel={() => setAskingStage(null)}
        />
      )}
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  )
}
