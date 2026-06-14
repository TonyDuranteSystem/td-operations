'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { CheckCircle2, Loader2 } from 'lucide-react'

interface ActionButtonsProps {
  serviceDeliveryId: string
  /** Action keys from stage_layout (e.g. ["complete"]). */
  actions?: string[]
}

/**
 * Stage action buttons driven by stage_layout `actions`. Currently supports the
 * "complete" action — a "Mark as Completed" button that advances the flow to its
 * final "Closed" stage via /api/flows/[id]/advance. advanceServiceDelivery owns
 * the side effects (for State Annual Report / State RA Renewal that means the
 * +1-year renewal-date bump and completion status). On success the page is
 * refreshed to show the completed state. Surfaces the server's real error
 * (R099) rather than a generic message.
 *
 * Unknown action keys are ignored, so adding new ones to a layout never breaks
 * the render.
 */
export function ActionButtons({ serviceDeliveryId, actions }: ActionButtonsProps) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const hasComplete = (actions ?? []).includes('complete')
  if (!hasComplete) return null

  async function handleComplete() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/flows/${serviceDeliveryId}/advance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_stage: 'Closed' }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Could not complete the flow. Please try again.')
      }
      router.refresh()
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not complete the flow.')
      setBusy(false)
    }
  }

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <button
        type="button"
        onClick={handleComplete}
        disabled={busy}
        className={`inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
          busy
            ? 'cursor-not-allowed bg-zinc-200 text-zinc-400'
            : 'cursor-pointer bg-emerald-600 text-white hover:bg-emerald-700'
        }`}
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
        {busy ? 'Completing…' : 'Mark as Completed'}
      </button>
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
    </div>
  )
}
