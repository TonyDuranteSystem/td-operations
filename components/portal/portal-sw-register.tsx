'use client'

import { useEffect } from 'react'
import { UpdateBanner } from '@/components/shared/update-banner'
import { PORTAL_SW_PATH, PORTAL_SW_SCOPE, portalUrlFromSwMessage, unregisterStrayPortalWorkers } from '@/lib/portal/sw-scope'

/**
 * Portal service worker registration + update banner.
 *
 * Also cleans up the stray scope-'/' registration that push-toggle.tsx created
 * before 2026-07-21 (dev job 454514f5). That duplicate was never polled for
 * updates and controlled the app's own launch URL. Harmless now that both call
 * sites share PORTAL_SW_SCOPE and the worker caches nothing, but the leftover
 * registration is removed wherever page JS is alive.
 */
export function PortalSwRegister({ locale }: { locale?: string }) {
  useEffect(() => {
    void unregisterStrayPortalWorkers()
  }, [])

  // Fallback for a tapped push notification when the worker couldn't move this
  // already-open window itself (see portal-sw.js notificationclick). Only
  // same-origin /portal targets are followed.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
    const onMessage = (event: MessageEvent) => {
      const url = portalUrlFromSwMessage(event.data, window.location.origin)
      if (url) window.location.assign(url)
    }
    navigator.serviceWorker.addEventListener('message', onMessage)
    return () => navigator.serviceWorker.removeEventListener('message', onMessage)
  }, [])

  return <UpdateBanner swPath={PORTAL_SW_PATH} scope={PORTAL_SW_SCOPE} locale={locale} />
}
