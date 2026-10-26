"use client"

import { X } from "lucide-react"
import type { ReadinessBlocker } from "@/lib/offers/service-readiness"

/**
 * "This offer can't be sent yet" — shown by the Send / Activate buttons when the server refuses because a service
 * on the offer is not ready (no steps, switched off, or no approved contract). It lists every reason with a link
 * that opens the service page, so the fix is one click away. Nothing was sent; the client sees nothing.
 */
export function OfferBlockedDialog({
  blockers,
  title = "This offer can’t be sent yet",
  retryText = "Once this is fixed, send the offer again.",
  onClose,
}: {
  blockers: ReadinessBlocker[]
  title?: string
  retryText?: string
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg" data-offer-blocked-dialog>
        <div className="flex items-start justify-between gap-3 p-5 border-b">
          <div>
            <h2 className="text-base font-semibold text-zinc-900">{title}</h2>
            <p className="text-sm text-zinc-500 mt-0.5">Nothing was sent. The client sees nothing.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="text-zinc-400 hover:text-zinc-700"><X className="h-5 w-5" /></button>
        </div>
        <div className="p-5 space-y-3">
          <p className="text-sm font-medium text-zinc-700">Before this offer can be sent</p>
          <ul className="space-y-2">
            {blockers.map((b, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-zinc-800 rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
                <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-amber-500" aria-hidden />
                <span className="flex-1">
                  {b.message}
                  {b.href && (
                    <>
                      {" "}
                      <a href={b.href} target="_blank" rel="noopener noreferrer" className="font-medium text-blue-700 underline whitespace-nowrap">
                        {b.kind === "contract" ? "Open contract" : "Open service"}
                      </a>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-sm text-zinc-500">{retryText}</p>
        </div>
        <div className="flex justify-end p-4 border-t">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm rounded-md bg-zinc-900 text-white hover:bg-zinc-700">Close</button>
        </div>
      </div>
    </div>
  )
}
