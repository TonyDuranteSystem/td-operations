'use client'

import { toast } from 'sonner'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Loader2 } from 'lucide-react'
import { useGoBackWarnings } from './use-go-back-warnings'

interface GoBackButtonProps {
  serviceDeliveryId: string
  /** The step the page is showing now: sent with the click so a job that moved meanwhile is not sent back from the wrong place. */
  currentStage?: string | null
  /** Label of the stage we'd return to, for the button copy (optional). */
  previousStageLabel?: string | null
  /** Things this particular Go Back also does or does not do, added to the question (e.g. "also deletes the saved IRS tracking number"). */
  extraWarnings?: string[]
}

/**
 * Flow Workspace "← Go Back" button — reverts the SD one stage via
 * /api/flows/[id]/revert. Rendered ONLY when there is a previous stage (the
 * page hides it on the first stage; the route also guards server-side).
 *
 * Destructive: confirms first because the revert deletes the document(s)
 * uploaded for the stage being re-opened. Styled as a secondary/outline button
 * so it never competes with the primary stage action. Surfaces the server's
 * real error (R099) rather than a generic message.
 */
export function GoBackButton({ serviceDeliveryId, currentStage, previousStageLabel, extraWarnings }: GoBackButtonProps) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // the page's lines + the tracking-number line when a number was saved after the page loaded (no reload needed)
  const warnings = useGoBackWarnings(serviceDeliveryId, extraWarnings)

  async function handleGoBack() {
    if (busy) return
    const confirmed = window.confirm(
      ['Are you sure? This will delete any documents uploaded at this stage and go back to the previous step.', ...warnings].join('\n\n'),
    )
    if (!confirmed) return

    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/flows/${serviceDeliveryId}/revert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(currentStage ? { expected_from_stage: currentStage } : {}),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Could not go back. Please try again.')
      }
      for (const w of (data.warnings ?? []) as string[]) toast.warning(w, { duration: 12000 })
      router.refresh()
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not go back.')
    } finally {
      // The button stays mounted when the step before still has a step before it: without this it kept saying "Going back…" and stayed
      // disabled after the move had worked (production end-to-end test 2026-11-07).
      setBusy(false)
    }
  }

  return (
    <div className="pt-2">
      <button
        type="button"
        onClick={handleGoBack}
        disabled={busy}
        className={`inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors ${
          busy
            ? 'cursor-not-allowed border-zinc-200 text-zinc-400'
            : 'cursor-pointer border-zinc-300 text-zinc-600 hover:bg-zinc-50'
        }`}
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowLeft className="h-4 w-4" />}
        {busy ? 'Going back…' : previousStageLabel ? `Go Back to ${previousStageLabel}` : '← Go Back'}
      </button>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  )
}
