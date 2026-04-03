'use client'

import { useSwUpdate } from '@/lib/hooks/use-sw-update'
import { RefreshCw } from 'lucide-react'

/**
 * PWA update banner — shows when a new service worker version is available.
 * Mount in both portal and dashboard layouts.
 *
 * Props:
 *   swPath — path to the service worker file (e.g., '/portal-sw.js')
 *   scope  — optional SW scope (e.g., '/portal/')
 */
export function UpdateBanner({ swPath, scope }: { swPath: string; scope?: string }) {
  const { updateAvailable, applyUpdate } = useSwUpdate(swPath, scope)

  if (!updateAvailable) return null

  // Detect language from html lang attribute
  const isItalian = typeof document !== 'undefined' && document.documentElement.lang === 'it'

  return (
    <div className="fixed top-0 left-0 right-0 z-50 bg-blue-600 text-white px-4 py-2.5 flex items-center justify-center gap-3 text-sm shadow-lg animate-in slide-in-from-top-2 duration-300">
      <RefreshCw className="h-4 w-4 shrink-0" />
      <span className="font-medium">
        {isItalian ? 'Una nuova versione è disponibile' : 'A new version is available'}
      </span>
      <button
        onClick={applyUpdate}
        className="bg-white text-blue-600 px-3 py-1 rounded-full text-xs font-bold hover:bg-blue-50 transition-colors"
      >
        {isItalian ? 'Aggiorna ora' : 'Update Now'}
      </button>
    </div>
  )
}
