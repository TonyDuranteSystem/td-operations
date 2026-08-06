'use client'

/**
 * Invisible funnel tracker mounted in the AUTHENTICATED portal layout
 * (Phase 2 of install adoption, dev job 8f38add1). Fires, once per device:
 *  - installed              — appinstalled while browsing the portal (Android)
 *  - standalone_launch      — first launch as an installed app
 *  - standalone_authenticated — first launch as an installed app WITH a
 *    session (the funnel's true finish line before push opt-in; the gap
 *    between this and standalone_launch measures the login cliff, D10c)
 *
 * Renders nothing. Staff and view-as sessions are excluded SERVER-side in
 * the events route — this component stays dumb on purpose (the client is
 * not a trust boundary).
 */

import { useEffect } from 'react'
import { postPwaEventOnce, PWA_DEDUP_KEYS } from '@/lib/portal/pwa-events'
import { detectDevice, INSTALL_SRC_STORAGE_KEY, normalizeInstallSrc } from '@/lib/portal/install-page-mode'

function isStandaloneNow(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches
    || (window.navigator as Navigator & { standalone?: boolean }).standalone === true
}

export function PwaEventsTracker() {
  useEffect(() => {
    const device = detectDevice(navigator.userAgent, {
      platform: navigator.platform,
      maxTouchPoints: navigator.maxTouchPoints,
    })

    if (isStandaloneNow()) {
      postPwaEventOnce(PWA_DEDUP_KEYS.standaloneLaunch, { event: 'standalone_launch', device })
      // This component only mounts in the authenticated layout branches, so a
      // standalone render here IS an authenticated standalone session.
      postPwaEventOnce(PWA_DEDUP_KEYS.standaloneAuthenticated, {
        event: 'standalone_authenticated',
        device,
      })
    }

    const onInstalled = () => {
      let src = null
      try { src = normalizeInstallSrc(sessionStorage.getItem(INSTALL_SRC_STORAGE_KEY)) } catch { /* private mode */ }
      // Once per device: a reinstall after uninstall logs nothing new — one
      // install row per device is the design.
      postPwaEventOnce(PWA_DEDUP_KEYS.installed, {
        event: 'installed',
        device,
        ...(src ? { src } : {}),
      })
    }
    window.addEventListener('appinstalled', onInstalled)
    return () => window.removeEventListener('appinstalled', onInstalled)
  }, [])

  return null
}
