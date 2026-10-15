'use client'

import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { ClosureWrapupPanel } from '@/components/flows/closure-wrapup-panel'

interface ClosureWrapupDialogProps {
  /** The Company Closure job (service delivery) id — the Calendar row's own id. */
  jobId: string
  /** Company name, or the person's name for a closure with no company record. */
  name: string
  /** What the job is and where it is, as the Calendar row shows it (e.g. "<service> · Step 5: <step>"). Passed in, never written here. */
  subtitle: string
  onClose: () => void
}

/**
 * The Wrap-up pop-up on the Calendar (Open services). The Calendar is where the team works every day, so the Wrap-up of a Company Closure
 * opens HERE, on the row, with everything about the company inside it: no jumping to the job page, to Finance or to the CRM (Antonio,
 * 2026-10-15). Slice 1 shows the facts; the decisions (save for later, close the company) are added to this same pop-up next.
 *
 * Same look as the Calendar's Mark Filed pop-up. Esc and the Close button close it; the page behind does not scroll while it is open.
 */
export function ClosureWrapupDialog({ jobId, name, subtitle, onClose }: ClosureWrapupDialogProps) {
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [onClose])

  const titleId = `wrapup-title-${jobId}`
  return createPortal(
    <>
      <div className="fixed inset-0 z-50 bg-black/50" onClick={onClose} />
      <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center p-4">
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          className="pointer-events-auto flex max-h-[90vh] w-full max-w-3xl flex-col rounded-lg bg-white shadow-xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex shrink-0 items-center justify-between border-b px-6 py-4">
            <div>
              <h2 id={titleId} className="text-base font-semibold text-zinc-900">
                {name}
              </h2>
              <p className="mt-0.5 text-xs text-zinc-500">{subtitle}</p>
            </div>
            <button type="button" onClick={onClose} className="rounded p-1 hover:bg-zinc-100" aria-label="Close">
              <X className="h-5 w-5 text-zinc-500" />
            </button>
          </div>
          <div className="overflow-y-auto px-6 py-4">
            <ClosureWrapupPanel serviceDeliveryId={jobId} variant="popup" />
          </div>
          <div className="flex shrink-0 justify-end border-t px-6 py-3">
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              className="rounded-md border px-4 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </>,
    document.body,
  )
}
