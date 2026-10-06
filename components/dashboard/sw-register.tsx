'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { UpdateBanner } from '@/components/shared/update-banner'
import { isInternalNavHref } from '@/lib/nav/nav-link'

/**
 * Dashboard service worker registration + update banner.
 * Replaces the old simple register-only component.
 *
 * Also answers a notification click (dev job f3f3e237): the worker asks THIS page to go to the
 * notification's target with a client-side navigation instead of reloading it, so floating windows
 * and what is typed in them survive. It replies on the message port so the worker knows not to fall
 * back to a full reload. Only a normal CRM path is ever followed.
 */
export function SwRegister() {
  const router = useRouter()

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { type?: string; url?: unknown } | null
      if (!d || d.type !== 'td-navigate' || typeof d.url !== 'string') return
      let path = d.url
      try {
        const u = new URL(d.url, window.location.origin)
        if (u.origin !== window.location.origin) return
        path = u.pathname + u.search + u.hash
      } catch {
        return
      }
      if (!isInternalNavHref(path)) return
      e.ports[0]?.postMessage('ok')
      router.push(path)
    }
    navigator.serviceWorker.addEventListener('message', onMessage)
    return () => navigator.serviceWorker.removeEventListener('message', onMessage)
  }, [router])

  return <UpdateBanner swPath="/dashboard-sw.js" />
}
