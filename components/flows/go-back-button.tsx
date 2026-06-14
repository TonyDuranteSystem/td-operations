'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Loader2 } from 'lucide-react'

interface GoBackButtonProps {
  serviceDeliveryId: string
  /** Label of the stage we'd return to, for the button copy (optional). */
  previousStageLabel?: string | null
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
export function GoBackButton({ serviceDeliveryId, previousStageLabel }: GoBackButtonProps) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleGoBack() {
    if (busy) return
    const confirmed = window.confirm(
      'Are you sure? This will delete any documents uploaded at this stage and go back to the previous step.',
    )
    if (!confirmed) return

    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/flows/${serviceDeliveryId}/revert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Could not go back. Please try again.')
      }
      router.refresh()
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not go back.')
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
