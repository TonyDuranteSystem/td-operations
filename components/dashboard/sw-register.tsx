'use client'

import { UpdateBanner } from '@/components/shared/update-banner'

/**
 * Dashboard service worker registration + update banner.
 * Replaces the old simple register-only component.
 */
export function SwRegister() {
  return <UpdateBanner swPath="/dashboard-sw.js" />
}
