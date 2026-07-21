'use client'

import { useEffect } from 'react'
import { UpdateBanner } from '@/components/shared/update-banner'
import { PORTAL_SW_PATH, PORTAL_SW_SCOPE, unregisterStrayPortalWorkers } from '@/lib/portal/sw-scope'

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

  return <UpdateBanner swPath={PORTAL_SW_PATH} scope={PORTAL_SW_SCOPE} locale={locale} />
}
