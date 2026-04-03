'use client'

import { UpdateBanner } from '@/components/shared/update-banner'

/**
 * Portal service worker registration + update banner.
 * Replaces the old simple register-only component.
 */
export function PortalSwRegister({ locale }: { locale?: string }) {
  return <UpdateBanner swPath="/portal-sw.js" scope="/portal/" locale={locale} />
}
