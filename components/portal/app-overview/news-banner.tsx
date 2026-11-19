'use client'

// Client iPhone app: the floating "new announcement" banner on the Overview (dev job 056a70d0). Small card that floats just above the app's
// bottom bar. Two choices: tap the words to read the news now, or "Later" (or swipe the card down) to put it away for this visit — it comes
// back the next time the app opens, until the client has read it. It is drawn into the page body (a portal) because the News button that
// owns it sits inside the company card, which clips anything drawn outside its own box.
import { useRef, useState, type TouchEvent } from 'react'
import { createPortal } from 'react-dom'
import { Megaphone } from 'lucide-react'

/** How far (in pixels) the card has to be dragged down before letting go counts as "Later". */
export const BANNER_SWIPE_DISTANCE = 48

export function AppNewsBanner({
  title,
  hint,
  laterLabel,
  onOpen,
  onLater,
}: {
  title: string
  hint: string
  laterLabel: string
  onOpen: () => void
  onLater: () => void
}) {
  const startY = useRef<number | null>(null)
  const [drag, setDrag] = useState(0)

  const onTouchStart = (e: TouchEvent) => { startY.current = e.touches[0]?.clientY ?? null }
  const onTouchMove = (e: TouchEvent) => {
    if (startY.current === null) return
    setDrag(Math.max(0, (e.touches[0]?.clientY ?? startY.current) - startY.current))
  }
  const onTouchEnd = () => {
    const far = drag >= BANNER_SWIPE_DISTANCE
    startY.current = null
    setDrag(0)
    if (far) onLater()
  }

  return createPortal(
    <div
      data-testid="app-news-banner"
      role="status"
      className="pointer-events-none fixed inset-x-0 z-50 px-4"
      style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 12px)' }}
    >
      <div
        data-testid="app-news-banner-card"
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
        style={{ transform: drag ? `translateY(${drag}px)` : undefined, touchAction: 'none' }}
        className="pointer-events-auto mx-auto flex max-w-md items-center gap-1 rounded-2xl bg-blue-600 p-1 pl-2 text-white shadow-xl ring-1 ring-black/10 animate-in fade-in slide-in-from-bottom-4 duration-300"
      >
        <button type="button" data-testid="app-news-banner-open" onClick={onOpen} className="flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-xl text-left">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/20">
            <Megaphone className="h-5 w-5" aria-hidden="true" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold leading-tight">{title}</span>
            <span className="block text-xs leading-tight text-blue-100">{hint}</span>
          </span>
        </button>
        <button
          type="button"
          data-testid="app-news-banner-later"
          onClick={onLater}
          className="flex min-h-11 shrink-0 items-center rounded-xl bg-white/15 px-3.5 text-sm font-semibold text-white"
        >
          {laterLabel}
        </button>
      </div>
    </div>,
    document.body,
  )
}
