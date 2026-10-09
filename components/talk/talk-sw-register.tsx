'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { UpdateBanner } from '@/components/shared/update-banner'
import { isInternalNavHref } from '@/lib/nav/nav-link'
import { isTalkPath, TALK_BASE } from '@/lib/talk/paths'

/**
 * Registers TD Talk's own service worker (scope /talk, NOT the CRM's) and answers a notification tap: the worker
 * asks THIS page to go to the tapped chat with a client-side navigation, so nothing typed is lost and the page
 * is not reloaded. Only a TD Talk address is ever followed (the worker has already rewritten it). Same pattern
 * as components/dashboard/sw-register.tsx.
 */
export function TalkSwRegister() {
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
      if (!isInternalNavHref(path) || !isTalkPath(path.split(/[?#]/)[0])) return
      e.ports[0]?.postMessage('ok')
      router.push(path)
    }
    navigator.serviceWorker.addEventListener('message', onMessage)
    return () => navigator.serviceWorker.removeEventListener('message', onMessage)
  }, [router])

  return <UpdateBanner swPath="/talk-sw.js" scope={TALK_BASE} />
}
