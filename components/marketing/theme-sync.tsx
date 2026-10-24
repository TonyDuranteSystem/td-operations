'use client'

import { useEffect } from 'react'
import { THEME_MESSAGE, parseTheme } from '@/lib/marketing/theme'

/** Inside a lead window: follows the look the workspace behind it is in (changed live by the switch, same site only). */
export function ThemeSync() {
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { type?: string; theme?: unknown } | null
      if (e.origin !== window.location.origin || !d || d.type !== THEME_MESSAGE) return
      document.getElementById('tdm-root')?.setAttribute('data-tdm-theme', parseTheme(d.theme))
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])
  return null
}
