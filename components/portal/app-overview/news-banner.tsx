'use client'

// Client iPhone app: the floating "new announcement" banner on the Overview (dev job 056a70d0). Small card that floats just above the app's
// bottom bar: tap anywhere on it to read the news, or tap the X to make it go away. It is drawn into the page body (a portal) because the
// News button that owns it sits inside the company card, which clips anything drawn outside its own box.
import { createPortal } from 'react-dom'
import { Megaphone, X } from 'lucide-react'

export function AppNewsBanner({
  title,
  hint,
  closeLabel,
  onOpen,
  onDismiss,
}: {
  title: string
  hint: string
  closeLabel: string
  onOpen: () => void
  onDismiss: () => void
}) {
  return createPortal(
    <div
      data-testid="app-news-banner"
      role="status"
      className="pointer-events-none fixed inset-x-0 z-50 px-4"
      style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 12px)' }}
    >
      <div className="pointer-events-auto mx-auto flex max-w-md items-center gap-1 rounded-2xl bg-blue-600 p-1 pl-2 text-white shadow-xl ring-1 ring-black/10 animate-in fade-in slide-in-from-bottom-4 duration-300">
        <button type="button" data-testid="app-news-banner-open" onClick={onOpen} className="flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-xl text-left">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/20">
            <Megaphone className="h-5 w-5" aria-hidden="true" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold leading-tight">{title}</span>
            <span className="block text-xs leading-tight text-blue-100">{hint}</span>
          </span>
        </button>
        <button type="button" data-testid="app-news-banner-close" aria-label={closeLabel} onClick={onDismiss} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white/90">
          <X className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>
    </div>,
    document.body,
  )
}
