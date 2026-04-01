'use client'

import { useEffect } from 'react'

/**
 * Registers the portal service worker on page load.
 * Required for PWA installability (Badging API, push notifications, offline).
 */
export function PortalSwRegister() {
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/portal-sw.js', { scope: '/portal/' }).catch(() => {
        // SW registration failed — non-critical, app still works
      })
    }
  }, [])

  return null
}
