'use client'

import { useEffect, useState } from 'react'
import { Download, Share2, Loader2 } from 'lucide-react'
import { useLocale } from '@/lib/portal/use-locale'

interface KitState {
  available: boolean
  download_url?: string
  file_name?: string
}

/**
 * Client-facing "Your social sharing kit" download card, shown on
 * /portal/td-communication once the project is delivered. Self-resolving: it
 * fetches the (kill-switch + delivered + IDOR gated) client endpoint on mount and
 * renders NOTHING when a kit isn't available — so the page can mount it
 * unconditionally in the delivered branch. The signed download URL is minted
 * fresh by the server (never stale). Any language (dev job 12cab351).
 */
export function SocialKitCard() {
  const { t } = useLocale()
  const [state, setState] = useState<KitState | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    fetch('/api/portal/td-communication/social-kit')
      .then((r) => (r.ok ? r.json() : { available: false }))
      .then((d) => {
        if (!cancelled) setState(d)
      })
      .catch(() => {
        if (!cancelled) setState({ available: false })
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Render nothing until we know a kit is available (no empty placeholder).
  if (loading || !state?.available || !state.download_url) return null

  const title = t('socialKit.title')
  const body = t('socialKit.body')
  const button = t('socialKit.button')

  return (
    <div className="mt-8 flex flex-col items-center gap-4 rounded-2xl border border-blue-200 bg-blue-50/60 px-6 py-7 text-center">
      <div className="flex items-center gap-2 text-blue-900">
        <Share2 className="h-5 w-5 shrink-0" />
        <h3 className="text-base font-semibold">{title}</h3>
      </div>
      <p className="max-w-md text-sm text-blue-900/80">{body}</p>
      <a
        href={state.download_url}
        download={state.file_name}
        className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-blue-700"
      >
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
        {button}
      </a>
    </div>
  )
}
