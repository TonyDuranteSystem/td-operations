'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { useT } from '@/components/marketing/lang-provider'
import { hasMarketingPush, subscribeToMarketingPush } from '@/lib/marketing/push-client'

type State = 'checking' | 'on' | 'off' | 'denied' | 'unsupported'

/**
 * A thin strip at the top of the workspace that offers notifications when somebody writes in a lead's chat (dev job 9aec66fa, Addendum G). Turning them on needs a tap
 * (browsers refuse a permission request that is not a direct result of one). Shows nothing once they are on. Also answers a tapped notification: the worker asks THIS page
 * to go to the address itself (so nothing typed is lost); only an address under /marketing is ever followed.
 */
export function MarketingPushBanner() {
  const t = useT()
  const router = useRouter()
  const [state, setState] = useState<State>('checking')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const ok = typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && typeof Notification !== 'undefined'
      if (!ok) { if (!cancelled) setState('unsupported'); return }
      if (Notification.permission === 'denied') { if (!cancelled) setState('denied'); return }
      const on = await hasMarketingPush().catch(() => false)
      // already subscribed in this browser: say so to the server again, silently (no prompt: the permission is already granted). That repairs a row the server dropped, and moves a shared computer's subscription to whoever is signed in now.
      if (on) void subscribeToMarketingPush().catch(() => undefined)
      if (!cancelled) setState(on ? 'on' : 'off')
    })()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { type?: string; url?: unknown } | null
      if (!d || d.type !== 'td-navigate' || typeof d.url !== 'string') return
      try {
        const u = new URL(d.url, window.location.origin)
        if (u.origin !== window.location.origin || !(u.pathname === '/marketing' || u.pathname.startsWith('/marketing/'))) return
        e.ports[0]?.postMessage('ok')
        router.push(u.pathname + u.search)
      } catch { /* not an address we follow */ }
    }
    navigator.serviceWorker.addEventListener('message', onMessage)
    return () => navigator.serviceWorker.removeEventListener('message', onMessage)
  }, [router])

  const enable = useCallback(async () => {
    setBusy(true)
    try {
      const r = await subscribeToMarketingPush()
      if (r === 'subscribed') { setState('on'); toast.success(t('Notifications are on.')) }
      else if (r === 'denied') setState('denied')
      else if (r === 'unsupported') setState('unsupported')
      else toast.error(t('Notifications are not set up on the server yet.'))
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : t('Could not turn on notifications. Please try again.'))
    } finally { setBusy(false) }
  }, [t])

  if (state === 'checking' || state === 'on' || state === 'unsupported') return null
  if (state === 'denied') return <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900" role="status">{t('Notifications are blocked in this browser. Allow them in the browser settings for this site.')}</div>
  return (
    <div className="flex items-center justify-between gap-3 border-b border-sky-100 bg-sky-50 px-4 py-2" role="status" data-testid="push-banner">
      <span className="text-xs text-sky-900">{t('Get a notification when someone writes to you in a lead.')}</span>
      <button type="button" onClick={enable} disabled={busy} className="shrink-0 rounded-full bg-slate-900 px-3 py-1 text-xs font-semibold text-white disabled:opacity-60" data-testid="push-enable">{busy ? t('Turning on…') : t('Turn on')}</button>
    </div>
  )
}
