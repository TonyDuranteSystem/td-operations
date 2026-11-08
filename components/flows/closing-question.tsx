'use client'

import { useCallback, useEffect, useState } from 'react'
import { closingQuestionButtons, type ClosingQuestionState } from '@/lib/closure/closing-step'

/** What GET /api/flows/[id]/closing-brief answers for the question. */
interface ClosingBriefView {
  headline: string
  lines: string[]
  /** the wizard named a different company than the one the job is linked to — shown in red, and "finish without closing" is offered */
  warning: string | null
}

interface ClosingQuestionProps {
  serviceDeliveryId: string
  /** The sentence the question starts with (the finish button's own, or the step bar's). */
  question: string
  /** An action is running — every button waits. */
  busy: boolean
  onConfirm: (opts?: { skipCompanyClose?: boolean }) => void
  onCancel: () => void
}

/**
 * The "this closes the company" question, shared by the workspace finish button and the step bar (production end-to-end test 2026-11-07: the
 * step bar closed a company after a bare "Move to Closing?"). It reads WHICH company and what goes with it (unpaid invoices, other services,
 * deadlines, people, a lease, the wizard's red warning) and only lets staff say yes once it has shown them — if the read fails it says so and
 * offers Try again, instead of falling back to a generic sentence with "Yes" enabled.
 */
export function ClosingQuestion({ serviceDeliveryId, question, busy, onConfirm, onCancel }: ClosingQuestionProps) {
  const [state, setState] = useState<ClosingQuestionState>('loading')
  const [brief, setBrief] = useState<ClosingBriefView | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  const load = useCallback(async () => {
    setState('loading')
    setFailure(null)
    try {
      const res = await fetch(`/api/flows/${serviceDeliveryId}/closing-brief`, { cache: 'no-store' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) throw new Error(data.error || 'Could not read the company.')
      if (data.brief) {
        setBrief({ headline: data.headline, lines: data.lines ?? [], warning: data.warning ?? null })
        setState('ready')
      } else {
        setBrief(null)
        setState('none')
      }
    } catch (err) {
      setFailure(err instanceof Error && err.message ? err.message : 'Could not read the company.')
      setState('failed')
    }
  }, [serviceDeliveryId])

  useEffect(() => { void load() }, [load])

  const buttons = closingQuestionButtons(state, !!brief?.warning)

  return (
    <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-3 text-sm text-amber-900" data-testid="closing-question">
      <p>{question}</p>
      {state === 'loading' && <p className="mt-2 text-amber-700">Checking the company…</p>}
      {state === 'failed' && (
        <p className="mt-2 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-red-800" data-testid="closing-question-failed">
          <span className="font-semibold">Could not read which company this closes and what goes with it.</span> {failure} You can only say yes once you can see it — press Try again.
        </p>
      )}
      {state === 'ready' && brief && (
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
          onClick={() => onConfirm()}
          disabled={busy || !buttons.canConfirm}
          className="inline-flex cursor-pointer items-center gap-2 rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-zinc-200 disabled:text-zinc-400"
        >
          Yes, confirm
        </button>
        {buttons.showRetry && (
          <button
            type="button"
            onClick={() => void load()}
            disabled={busy}
            className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-amber-400 bg-white px-4 py-2 text-sm font-medium text-amber-800 hover:bg-amber-100 disabled:cursor-not-allowed"
          >
            Try again
          </button>
        )}
        {buttons.showSkip && (
          <button
            type="button"
            onClick={() => onConfirm({ skipCompanyClose: true })}
            disabled={busy}
            className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed"
          >
            Finish the job without closing the company
          </button>
        )}
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
