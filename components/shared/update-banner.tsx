'use client'

import { useState } from 'react'
import { useSwUpdate } from '@/lib/hooks/use-sw-update'
import { useReleaseCheck } from '@/lib/hooks/use-release-check'
import { RefreshCw, X } from 'lucide-react'

/**
 * Update banner — ONE bar for both signals. Mount in the portal and dashboard layouts.
 *
 * Signals:
 *   - a new service-worker file is waiting (the original signal; rare, because the worker file almost never changes), and
 *   - `checkRelease` (CRM only, dev job dc629a3d): the live site is running a different release than this page was loaded with
 *     (lib/hooks/use-release-check.ts) — this is the one that fires for ordinary releases.
 * They share this bar so they can never stack. With `checkRelease` the wording is "New release available — refresh to update" and
 * the bar can be closed for the release it announced (a newer release shows it again; a reload clears it for good).
 *
 * Props:
 *   swPath — path to the service worker file (e.g., '/portal-sw.js')
 *   scope  — optional SW scope (e.g., '/portal/')
 *   checkRelease — also watch the live release (CRM; the portal keeps the worker-only bar)
 */
export function UpdateBanner({ swPath, scope, locale, checkRelease = false }: { swPath: string; scope?: string; locale?: string; checkRelease?: boolean }) {
  const { updateAvailable, applyUpdate } = useSwUpdate(swPath, scope)
  const release = useReleaseCheck(checkRelease)
  const [closedFor, setClosedFor] = useState<string | null>(null)

  const announcing = updateAvailable || release.show
  if (!announcing) return null
  // what a close applies to: the release id this bar announced (a newer one re-opens it); the worker signal has no id
  const key = release.show && release.live ? release.live : 'worker'
  if (checkRelease && closedFor === key) return null

  // Use explicit locale prop, or default to English (root layout has lang="it" which is wrong for CRM)
  const isItalian = locale === 'it'
  const text = checkRelease
    ? 'New release available — refresh to update'
    : isItalian ? 'Una nuova versione è disponibile' : 'A new version is available'
  const button = checkRelease ? 'Refresh' : isItalian ? 'Aggiorna ora' : 'Update Now'

  const onApply = () => {
    if (updateAvailable) applyUpdate()
    // a waiting worker reloads the page when it takes over; without one (or if it does not), reload ourselves
    if (!updateAvailable || checkRelease) window.setTimeout(() => window.location.reload(), updateAvailable ? 2000 : 0)
  }

  return (
    <div data-update-banner="" role="status" className="fixed top-0 left-0 right-0 z-50 bg-blue-600 text-white px-4 py-2.5 flex items-center justify-center gap-3 text-sm shadow-lg animate-in slide-in-from-top-2 duration-300">
      <RefreshCw className="h-4 w-4 shrink-0" />
      <span className="font-medium">{text}</span>
      <button
        onClick={onApply}
        className="bg-white text-blue-600 px-3 py-1 rounded-full text-xs font-bold hover:bg-blue-50 transition-colors"
      >
        {button}
      </button>
      {checkRelease && (
        <button
          type="button"
          onClick={() => setClosedFor(key)}
          aria-label="Close — remind me at the next release"
          className="shrink-0 rounded p-1 hover:bg-blue-700"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  )
}
