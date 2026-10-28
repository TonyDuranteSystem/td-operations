'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeftRight, ChevronDown, ChevronUp, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { TourRing } from '@/components/ui/tour-ring'
import { acquireTour, releaseTour } from '@/lib/ui/tour-lock'
import { FLOW_DOC_UPLOADED_EVENT, type FlowDocUploadedDetail } from '@/components/flows/document-upload'
import {
  GUIDE_DONE_TEXT, GUIDE_FINISHED_TEXT, guideCardText, guideNotReadyText, planGuide, readGuideOff, ringSelector, uploadSubStep, writeGuideOff,
  type GuideCardText, type GuideStageDef, type UploadSub,
} from '@/lib/flows/workspace-guide'

/**
 * The workspace GUIDE (dev job e3215801 — Antonio 2026-10-28, the model for all workspaces): a small card plus a glowing ring on the REAL next click.
 * Started by the "A workspace step is waiting for this document" pop-up ("Open the workspace" opens /flows/<id>?guide=<document type>), never by itself.
 *
 * It never clicks for the person and never blocks the page (same look and the same "one tour at a time" lock as the floating-windows tour). Every step is
 * worked out again from the LIVE case each time the page refreshes (lib/flows/workspace-guide.ts), so a step finishes only when the person REALLY did it:
 * after they press the stage button the case is at the next stage and there is one step fewer; the upload box is followed part by part (choose the file,
 * check the type, press the upload button); the end card appears when the upload really succeeded. A case that is not at a stage where this document is
 * expected gets a warning only. "Stop guide" ends it; "Don't guide me again" keeps it off on this computer.
 */

const LOCK = 'workspace-guide'

function localStore(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/** Take ?guide= out of the address, so a reload or a later refresh does not start the guide again. */
function removeGuideParam() {
  try {
    const u = new URL(window.location.href)
    if (!u.searchParams.has('guide')) return
    u.searchParams.delete('guide')
    window.history.replaceState(window.history.state, '', `${u.pathname}${u.search}${u.hash}`)
  } catch { /* an address we cannot rewrite: the guide just stays on this page */ }
}

export interface WorkspaceGuideProps {
  serviceDeliveryId: string
  currentStage: string | null
  status: string | null
  /** The document the guide is about (the ?guide= value, already checked against the table on the server). */
  documentType: string
  stages: GuideStageDef[]
  /** From the step table: "the IRS approval letter (CP565)", what the workspace does after the upload, and the stages where the document is waiting. */
  asks: string
  does: string[]
  readyStages: string[]
}

export function WorkspaceGuide({ serviceDeliveryId, currentStage, status, documentType, stages, asks, does, readyStages }: WorkspaceGuideProps) {
  const [started, setStarted] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [side, setSide] = useState<'right' | 'left'>('right')
  const [uploaded, setUploaded] = useState(false)
  const [sub, setSub] = useState<UploadSub>('choose')
  const [missing, setMissing] = useState(false)
  const [covered, setCovered] = useState(false)

  const plan = useMemo(
    () => planGuide({ stages, currentStage, status, documentType, readyStages }),
    [stages, currentStage, status, documentType, readyStages],
  )
  const steps = plan.kind === 'steps' ? plan.steps : []
  const step = steps[0] ?? null
  // "Step 2 of 3": the total is what the plan was when the guide started — it only shrinks as the person really does the steps
  const [startTotal] = useState(() => (plan.kind === 'steps' ? plan.steps.length : 0))
  const total = Math.max(startTotal, steps.length)
  const stepNo = total - steps.length + 1

  const stepKindRef = useRef<string | null>(null)
  stepKindRef.current = step?.kind ?? null

  // ── start: only when this person has not turned the guide off and no other tour is open ──
  useEffect(() => {
    if (readGuideOff(localStore())) {
      removeGuideParam()
      return
    }
    if (!acquireTour(LOCK)) return
    setStarted(true)
    return () => releaseTour(LOCK)
  }, [])

  const stop = useCallback(() => {
    releaseTour(LOCK)
    setStarted(false)
    removeGuideParam()
  }, [])
  const stopForever = useCallback(() => {
    writeGuideOff(localStore(), true)
    stop()
  }, [stop])

  // ── the upload really happened (the box tells the page after a successful save) ──
  useEffect(() => {
    if (!started) return
    const on = (e: Event) => {
      const d = (e as CustomEvent<FlowDocUploadedDetail>).detail
      if (d?.serviceDeliveryId === serviceDeliveryId && stepKindRef.current === 'upload') setUploaded(true)
    }
    window.addEventListener(FLOW_DOC_UPLOADED_EVENT, on)
    return () => window.removeEventListener(FLOW_DOC_UPLOADED_EVENT, on)
  }, [started, serviceDeliveryId])

  // ── the upload box is followed part by part: the file picked? the type chosen? ──
  const uploadType = step?.kind === 'upload' ? step.documentType : null
  useEffect(() => {
    if (!started || !uploadType || uploaded) return
    const tick = () => {
      const root = document.querySelector(`[data-guide-box="${uploadType}"]`)
      if (!root) return
      const file = root.querySelector('input[type="file"]') as HTMLInputElement | null
      const select = root.querySelector('[data-guide-part="type"]') as HTMLSelectElement | null
      setSub(uploadSubStep({ fileChosen: !!file?.files && file.files.length > 0, hasTypePicker: !!select, typeValue: select?.value ?? '' }))
    }
    tick()
    const id = window.setInterval(tick, 250)
    return () => window.clearInterval(id)
  }, [started, uploadType, uploaded])

  const selector = started && step && !uploaded ? ringSelector(step, step.kind === 'upload' ? sub : 'choose') : null

  // ── a step whose target is not on the screen is never a stall: the card says what to look for ──
  useEffect(() => {
    setMissing(false)
    if (!selector) return
    const check = () => setMissing(!document.querySelector(selector))
    const first = window.setTimeout(check, 1200)
    const id = window.setInterval(check, 1000)
    return () => {
      window.clearTimeout(first)
      window.clearInterval(id)
    }
  }, [selector])

  if (!started) return null
  if (plan.kind === 'inactive' && plan.reason === 'no_box' && !uploaded) return null

  let text: GuideCardText
  let header = 'Guide'
  let closing = false // an end / warning card: one Close button instead of the guide controls
  if (uploaded) {
    text = GUIDE_DONE_TEXT
    closing = true
  } else if (plan.kind === 'inactive') {
    text = GUIDE_FINISHED_TEXT
    closing = true
  } else if (plan.kind === 'not_ready') {
    text = guideNotReadyText(plan, asks)
    closing = true
  } else {
    text = guideCardText({ step: step!, sub, asks, does, next: steps[1] ?? null })
    header = `Step ${stepNo} of ${total}`
  }

  return (
    <>
      <TourRing selector={selector} stepKey={`${step?.kind ?? 'none'}:${step?.stage ?? ''}:${sub}`} onCovered={setCovered} />
      <section
        role="region"
        aria-label="Workspace guide"
        data-testid="workspace-guide"
        className={cn(
          'pointer-events-auto fixed bottom-24 z-[47] w-[22rem] max-w-[calc(100vw-2rem)] rounded-xl border border-emerald-300 bg-white text-zinc-800 shadow-2xl',
          side === 'right' ? 'right-4' : 'left-4',
        )}
      >
        {collapsed ? (
          <div className="flex items-center gap-2 px-3 py-2 text-sm">
            <span className="font-medium">Guide — {header}</span>
            <button type="button" onClick={() => setCollapsed(false)} aria-label="Show the guide card" className="ml-auto rounded p-1 hover:bg-zinc-100">
              <ChevronUp className="h-4 w-4" />
            </button>
            <button type="button" onClick={stop} aria-label="Stop the guide" className="rounded p-1 hover:bg-zinc-100">
              <X className="h-4 w-4" />
            </button>
          </div>
        ) : (
          <div className="flex flex-col">
            <div className="flex items-center gap-1 border-b border-emerald-100 bg-emerald-50 px-3 py-1.5 text-xs text-emerald-900">
              <span className="font-semibold">{header}</span>
              <span className="ml-auto flex items-center">
                <button type="button" onClick={() => setSide((s) => (s === 'right' ? 'left' : 'right'))} aria-label="Move the card to the other side" className="rounded p-1 hover:bg-emerald-100">
                  <ArrowLeftRight className="h-3.5 w-3.5" />
                </button>
                <button type="button" onClick={() => setCollapsed(true)} aria-label="Shrink the card" className="rounded p-1 hover:bg-emerald-100">
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
                <button type="button" onClick={stop} aria-label="Stop the guide" className="rounded p-1 hover:bg-emerald-100">
                  <X className="h-3.5 w-3.5" />
                </button>
              </span>
            </div>
            <div className="space-y-2.5 px-4 py-3 text-sm leading-relaxed">
              <h3 className="text-[15px] font-bold" data-testid="workspace-guide-title">{text.title}</h3>
              <p data-testid="workspace-guide-body">{text.body}</p>
              {!closing && missing && step && (
                <p className="rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800">
                  I can&apos;t find it on the screen. Look for {step.kind === 'press' ? <>the &quot;{step.label}&quot; button</> : <>the &quot;{step.boxLabel}&quot; box</>}.
                </p>
              )}
              {!closing && covered && (
                <p className="rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800">
                  The card may be covering it — press the arrows at the top of the card to move it to the other side.
                </p>
              )}
              <div className="flex flex-wrap items-center gap-2 pt-1">
                {closing ? (
                  <button type="button" onClick={stop} className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700">
                    Close
                  </button>
                ) : (
                  <>
                    <button type="button" onClick={stop} className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50">
                      Stop guide
                    </button>
                    <button type="button" onClick={stopForever} className="text-xs text-zinc-500 underline hover:text-zinc-700">
                      Don&apos;t guide me again
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      </section>
    </>
  )
}
