'use client'

/**
 * "Share" on a picture already sitting in My Captures (Antonio, 2026-09-05:
 * "opens the exact same send-to screen you already get right after taking a
 * screenshot"). Wraps DestinationFlow with `resend` — see that file's and
 * share-actions.ts's header comments for why an already-sent capture is
 * exactly what this path is FOR, unlike the original post-capture flow.
 *
 * Deliberately its own small modal, not folded into the lightbox — it needs
 * its own done/error stage (mirroring capture-layer.tsx's outer stage
 * machine, just scoped to this one small flow) and must stack ABOVE the
 * lightbox it's launched from, not replace it.
 */
import { useState } from 'react'
import { X } from 'lucide-react'
import { DestinationFlow } from '@/components/captures/destination-flow'

export function ShareExistingModal({
  captureId,
  imageUrl,
  onClose,
}: {
  captureId: string
  imageUrl: string
  onClose: () => void
}) {
  const [stage, setStage] = useState<'choice' | 'done' | 'error'>('choice')
  const [doneMessage, setDoneMessage] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const handleDone = (message?: string) => {
    setDoneMessage(message ?? null)
    setStage('done')
    setTimeout(onClose, 1200)
  }
  const handleError = (message: string) => {
    setErrorMessage(message)
    setStage('error')
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-sm flex-col gap-3 overflow-y-auto rounded-xl bg-white p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold">Share this picture</span>
          <button onClick={onClose} className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        {stage === 'choice' && (
          <DestinationFlow captureId={captureId} imageUrl={imageUrl} resend onDone={handleDone} onError={handleError} />
        )}

        {stage === 'done' && (
          <div className="py-8 text-center text-sm text-emerald-600">{doneMessage ?? 'Sent.'}</div>
        )}

        {stage === 'error' && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-red-600">{errorMessage}</p>
            <button
              onClick={() => setStage('choice')}
              className="rounded-md border border-zinc-200 px-4 py-2 text-sm hover:bg-zinc-50"
            >
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
