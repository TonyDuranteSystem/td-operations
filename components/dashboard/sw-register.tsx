'use client'

import { useEffect } from 'react'

/**
 * Registers the dashboard service worker on page load.
 * Required for Chrome PWA installability (install icon in address bar).
 */
export function SwRegister() {
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/dashboard-sw.js').catch(() => {
        // SW registration failed — non-critical, app still works
      })
    }
  }, [])

  return null
}
