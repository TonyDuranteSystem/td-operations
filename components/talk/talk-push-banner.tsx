'use client'

import { useCallback, useEffect, useState } from 'react'
import { Bell } from 'lucide-react'
import { toast } from 'sonner'
import { subscribeToDashboardPush } from '@/lib/push/dashboard-push'
import { TALK_BASE } from '@/lib/talk/paths'

type PushState = 'checking' | 'on' | 'off' | 'denied' | 'needs-install'

const PUSH_TARGET = { swPath: '/talk-sw.js', scope: TALK_BASE, app: 'talk' }

/** Opened from the home-screen icon (not a Safari tab)? iPhone only allows push from an installed app. */
function isInstalledApp(): boolean {
  if (typeof window === 'undefined') return false
  const nav = window.navigator as Navigator & { standalone?: boolean }
  return window.matchMedia('(display-mode: standalone)').matches || nav.standalone === true
}

/**
 * A thin strip above the chat that offers to turn on phone notifications for THIS app (dev job c1e326dd).
 * Turning them on needs a tap — iPhone refuses a permission request that is not a direct result of one — and
 * only works from the installed app. Shows nothing once notifications are on.
 */
export function TalkPushBanner() {
  const [state, setState] = useState<PushState>('checking')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const hasPush = typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && typeof Notification !== 'undefined'
      if (!hasPush) { if (!cancelled) setState(isInstalledApp() ? 'denied' : 'needs-install'); return }
      if (Notification.permission === 'denied') { if (!cancelled) setState('denied'); return }
      try {
        const reg = await navigator.serviceWorker.getRegistration(TALK_BASE)
        const mine = reg && new URL(reg.scope).pathname === TALK_BASE ? reg : null
        const sub = await mine?.pushManager.getSubscription()
        if (!cancelled) setState(sub && Notification.permission === 'granted' ? 'on' : 'off')
      } catch {
        if (!cancelled) setState('off')
      }
    })()
    return () => { cancelled = true }
  }, [])

  const enable = useCallback(async () => {
    setBusy(true)
    try {
      const r = await subscribeToDashboardPush(PUSH_TARGET)
      if (r === 'subscribed') { setState('on'); toast.success('Notifications are on for TD Talk.') }
      else if (r === 'denied') { setState('denied') }
      else if (r === 'unsupported') { setState('needs-install') }
      else toast.error('Notifications are not set up on the server yet.')
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Could not turn on notifications. Please try again.')
    } finally {
      setBusy(false)
    }
  }, [])

  if (state === 'checking' || state === 'on') return null

  if (state === 'needs-install') {
    return (
      <div className="shrink-0 border-b border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
        To get notifications on iPhone: tap the Share button, choose <b>Add to Home Screen</b>, then open TD Talk from its icon.
      </div>
    )
  }
  if (state === 'denied') {
    return (
      <div className="shrink-0 border-b border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
        Notifications are blocked for TD Talk. Turn them on in your phone&apos;s Settings → Notifications → TD Talk.
      </div>
    )
  }
  return (
    <div className="shrink-0 flex items-center justify-between gap-3 border-b border-red-100 bg-red-50 px-3 py-2">
      <span className="text-xs text-red-900">Get a notification when someone writes to you.</span>
      <button
        type="button"
        onClick={enable}
        disabled={busy}
        className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[#BE1E2D] px-3 py-1 text-xs font-semibold text-white disabled:opacity-60"
      >
        <Bell className="h-3.5 w-3.5" /> {busy ? 'Turning on…' : 'Turn on'}
      </button>
    </div>
  )
}
