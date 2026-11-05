'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { AlertTriangle, X } from 'lucide-react'
import { refreshIncident, useIncidentState } from '@/lib/infra/incident-client'
import { CLIENT_UPLOAD_MESSAGE, staffMessage } from '@/lib/infra/supabase-status'
import { useAppMode } from '@/lib/app-mode/app-mode-context'

/**
 * The red bar shown to staff (and to the TD Marketing team) while Supabase reports an incident on the services we stand on, and a neutral
 * line to clients while uploads are down. It asks the server once a minute while the window is in front and again when the app comes back.
 * The bar can be closed; it comes back when Supabase posts a new update (the closed state is keyed by the update's time).
 */
export function SupabaseIncidentBar({ audience }: { audience: 'staff' | 'client' }) {
  const pathname = usePathname()
  const state = useIncidentState()
  const appMode = useAppMode()
  const [closedAt, setClosedAt] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    let alive = true
    const go = () => { if (alive && document.visibilityState === 'visible') void refreshIncident(pathname ?? undefined) }
    go()
    const timer = setInterval(go, 60_000)
    document.addEventListener('visibilitychange', go)
    window.addEventListener('focus', go)
    return () => { alive = false; clearInterval(timer); document.removeEventListener('visibilitychange', go); window.removeEventListener('focus', go) }
  }, [pathname])

  if (!state || 'unknown' in state) return null
  if (audience === 'client') {
    if (state.audience !== 'client' || !state.uploadsDown) return null
    return (
      <div role="status" className="sticky top-0 z-[95] w-full bg-amber-500 px-4 py-2 text-center text-sm font-medium text-white" data-testid="supabase-incident-bar-client">
        {CLIENT_UPLOAD_MESSAGE}
      </div>
    )
  }
  if (state.audience !== 'staff' || !state.incident) return null
  const incident = state.incident
  if (closedAt === incident.latestUpdateAt) return null
  // Inside the TD Social phone app the notice stays (staff must still be told "it is Supabase, not you") but takes ONE
  // line, not a fifth of the screen: tap it to read the whole message, tap again to fold it (Step 1b, fix-list item 12).
  if (appMode) {
    return (
      <div role="alert" className="sticky top-0 z-[95] flex w-full items-start gap-2 bg-red-600 px-3 py-1 text-xs text-white shadow" data-testid="supabase-incident-bar">
        <AlertTriangle className="mt-1 h-4 w-4 shrink-0" />
        <button type="button" onClick={() => setExpanded(e => !e)} aria-expanded={expanded} className="min-h-[44px] min-w-0 flex-1 text-left">
          <span className={expanded ? 'block' : 'block truncate'}>{staffMessage(incident)}</span>
        </button>
        <button type="button" onClick={() => setClosedAt(incident.latestUpdateAt)} aria-label="Close" className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded hover:bg-red-700"><X className="h-4 w-4" /></button>
      </div>
    )
  }
  // On a PHONE the bar must sit UNDER the menu drawer (z-50) and its dimmed backdrop (z-40): at z-95 it painted over the top of the
  // open menu and hid its first rows (dev job 362a72a9). It stays above ordinary page content, below the phone header and every
  // overlay. On a computer (lg and up) there is no drawer: it keeps its old z-95.
  return (
    <div role="alert" className="sticky top-0 z-[39] lg:z-[95] flex w-full items-start gap-2 bg-red-600 px-4 py-2 text-sm text-white shadow" data-testid="supabase-incident-bar">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <p className="min-w-0 flex-1">{staffMessage(incident)}</p>
      <button type="button" onClick={() => setClosedAt(incident.latestUpdateAt)} aria-label="Close" className="shrink-0 rounded p-0.5 hover:bg-red-700"><X className="h-4 w-4" /></button>
    </div>
  )
}
