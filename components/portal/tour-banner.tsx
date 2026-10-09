'use client'

import { useEffect, useState } from 'react'
import { Sparkles, X } from 'lucide-react'
import { TOUR_EVENT_START, TOUR_EVENT_STATE, shouldShowTourBanner, type TourStateEvent } from '@/lib/portal/guides/guides'

/**
 * A slim, one-line "New: ... take the 1-minute tour" strip at the top of the invoices page (Antonio 2026-10-09).
 * Green so it is not mistaken for an error or a chat counter; it pulses gently (and stays still for anyone whose
 * device asks for reduced motion, or while the pointer is on it). The button starts the SAME tour as "Take the tour".
 *
 * Only rendered by the server when the tour is still being offered to this login, so it also follows the hub
 * roll-out switch and never shows in a staff view-as session.
 */
export function TourBanner({
  tourId, version, text, cta, closeLabel,
}: { tourId: string; version: number; text: string; cta: string; closeLabel: string }) {
  const closedKey = `td-tour-banner-closed-${tourId}-v${version}`
  const [closedHere, setClosedHere] = useState(false)
  const [state, setState] = useState<TourStateEvent | null>(null)

  useEffect(() => {
    try { if (window.localStorage.getItem(closedKey) === '1') setClosedHere(true) } catch { /* storage unavailable: just show it */ }
    const onState = (e: Event) => {
      const d = (e as CustomEvent<{ tourId: string; state: TourStateEvent }>).detail
      if (d && d.tourId === tourId) setState(d.state)
    }
    window.addEventListener(TOUR_EVENT_STATE, onState)
    return () => window.removeEventListener(TOUR_EVENT_STATE, onState)
  }, [tourId, closedKey])

  if (!shouldShowTourBanner({ offered: true, closedHere, state })) return null

  return (
    <div
      role="status"
      data-testid="tour-banner"
      className="flex items-center gap-3 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-sm text-emerald-900 motion-safe:animate-pulse hover:animate-none"
    >
      <Sparkles className="h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate font-medium">{text}</span>
      <button
        type="button"
        data-testid="tour-banner-start"
        onClick={() => window.dispatchEvent(new CustomEvent(TOUR_EVENT_START, { detail: { tourId } }))}
        className="shrink-0 rounded-md bg-emerald-600 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-700"
      >
        {cta}
      </button>
      <button
        type="button"
        aria-label={closeLabel}
        onClick={() => { setClosedHere(true); try { window.localStorage.setItem(closedKey, '1') } catch { /* ignore */ } }}
        className="shrink-0 rounded p-1 text-emerald-700 hover:bg-emerald-100"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
