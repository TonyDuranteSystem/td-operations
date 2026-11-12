'use client'

import { useState } from 'react'
import { useSwUpdate } from '@/lib/hooks/use-sw-update'
import { useReleaseCheck } from '@/lib/hooks/use-release-check'
import { useReleaseNotes } from '@/lib/hooks/use-release-notes'
import { ReleaseNotesPanel } from '@/components/releases/release-notes-panel'
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
  // "See what's new" (dev job 616dc839): what the announced release changes, shown BEFORE anyone refreshes. Only the CRM bar carries it.
  const described = useReleaseNotes(checkRelease && release.show ? release.live : null)
  const [panelFor, setPanelFor] = useState<string | null>(null)

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

  const canDescribe = checkRelease && release.show && !!release.live && described.notes.length > 0
  const panelOpen = canDescribe && panelFor === key

  const onApply = () => {
    if (updateAvailable) applyUpdate()
    // a waiting worker reloads the page when it takes over; without one (or if it does not), reload ourselves
    if (!updateAvailable || checkRelease) window.setTimeout(() => window.location.reload(), updateAvailable ? 2000 : 0)
  }

  return (
    // one fixed holder: the bar, and under it (when open) the "See what's new" panel — so a bar that wraps on a phone pushes the panel down
    <div className="fixed top-0 left-0 right-0 z-50">
    <div data-update-banner="" role="status" className="bg-blue-600 text-white px-4 py-2.5 flex flex-wrap items-center justify-center gap-x-3 gap-y-2 text-sm shadow-lg animate-in slide-in-from-top-2 duration-300">
      <RefreshCw className="h-4 w-4 shrink-0" />
      <span className="font-medium">{text}</span>
      {canDescribe && (
        <button
          type="button"
          onClick={() => setPanelFor(panelOpen ? null : key)}
          aria-expanded={panelOpen}
          className="rounded-full border border-white/70 px-3 py-1 text-xs font-semibold hover:bg-blue-700 transition-colors"
        >
          {panelOpen ? 'Hide details' : "See what's new"}
        </button>
      )}
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
    {panelOpen && <ReleaseNotesPanel notes={described.notes} more={described.more} onRefresh={onApply} onClose={() => setPanelFor(null)} />}
    </div>
  )
}
