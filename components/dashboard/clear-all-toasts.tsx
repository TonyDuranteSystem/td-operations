'use client'

import { toast, useSonner } from 'sonner'
import { X } from 'lucide-react'

/**
 * Floating "Clear all" pill for the CRM dashboard notification stack.
 *
 * The bottom-right notifications (portal messages, signed docs, payments) each
 * carry their own close ✕. When several pile up, dismissing them one at a time
 * is tedious — this pill dismisses the whole stack in one click.
 *
 * Placement: pinned to the very bottom of the bottom-right corner, in the thin
 * band reserved by the root <Toaster offset> (see app/layout.tsx). The toast
 * stack grows UPWARD from just above this band, so the pill never overlaps a
 * toast, on desktop or on the mobile PWA. Only shown when 2+ toasts are stacked
 * (a single toast's own ✕ is enough). Dashboard-only — never mounted in the
 * client portal, so clients never see it.
 */
export function ClearAllToasts() {
  const { toasts } = useSonner()

  if (toasts.length < 2) return null

  return (
    <button
      type="button"
      onClick={() => toast.dismiss()}
      aria-label={`Clear all ${toasts.length} notifications`}
      className="fixed bottom-3 right-6 z-[9999] flex items-center gap-1.5 rounded-full border border-zinc-200 bg-white/95 px-3 py-1.5 text-xs font-medium text-zinc-700 shadow-lg backdrop-blur transition-colors hover:bg-zinc-100 hover:text-zinc-900 sm:right-6"
    >
      <X className="h-3.5 w-3.5" />
      Clear all ({toasts.length})
    </button>
  )
}
