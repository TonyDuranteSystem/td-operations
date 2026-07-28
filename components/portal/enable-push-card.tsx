'use client'

import { useState, useEffect, useCallback } from 'react'
import { usePathname } from 'next/navigation'
import { Bell, X, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { useLocale } from '@/lib/portal/use-locale'
import { urlBase64ToUint8Array } from '@/lib/push/dashboard-push'
import { PORTAL_SW_PATH, PORTAL_SW_SCOPE } from '@/lib/portal/sw-scope'
import {
  shouldShowEnablePushCard,
  PUSH_CARD_DISMISS_KEY,
} from '@/lib/portal/push-card-visibility'

const COPY = {
  en: {
    title: 'Turn on notifications',
    body: 'Get instant alerts on this device when our team writes to you — instead of emails.',
    enable: 'Enable notifications',
    enabled: 'Notifications enabled — you’re all set',
    denied: 'Notification permission denied',
    failed: 'Could not enable notifications',
    close: 'Dismiss',
  },
  it: {
    title: 'Attiva le notifiche',
    body: 'Ricevi avvisi istantanei su questo dispositivo quando il nostro team ti scrive — al posto delle email.',
    enable: 'Attiva le notifiche',
    enabled: 'Notifiche attivate — tutto pronto',
    denied: 'Permesso per le notifiche negato',
    failed: 'Impossibile attivare le notifiche',
    close: 'Chiudi',
  },
} as const

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  )
}

/**
 * One-tap "enable notifications" card for the installed portal app.
 *
 * Closes the mobile funnel gap: install banners exist, but nothing asked for
 * the push permission after install (the header PushToggle is desktop-only,
 * the Settings toggle is buried). Push is what stops the fallback
 * notification emails. Visibility rules live in
 * lib/portal/push-card-visibility.ts (pure, unit-tested); visually limited to
 * mobile (lg:hidden) because desktop keeps the header toggle.
 */
export function EnablePushCard({ accountId }: { accountId: string }) {
  const pathname = usePathname()
  const { locale } = useLocale()
  const c = COPY[locale === 'it' ? 'it' : 'en']
  const [show, setShow] = useState(false)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (pathname !== '/portal') return
    let cancelled = false
    async function check() {
      const pushSupported =
        'serviceWorker' in navigator && 'PushManager' in window
      let subscribed = false
      if (pushSupported) {
        try {
          const registration =
            await navigator.serviceWorker.getRegistration(PORTAL_SW_SCOPE)
          subscribed = !!(await registration?.pushManager.getSubscription())
        } catch {
          // treat as unsubscribed
        }
      }
      let dismissedAt: number | null = null
      try {
        const raw = localStorage.getItem(PUSH_CARD_DISMISS_KEY)
        dismissedAt = raw ? parseInt(raw, 10) || null : null
      } catch {
        // localStorage unavailable — never dismissed
      }
      if (cancelled) return
      setShow(
        shouldShowEnablePushCard({
          standalone: isStandalone(),
          pushSupported,
          permission: pushSupported ? Notification.permission : 'denied',
          subscribed,
          dismissedAt,
          now: Date.now(),
        }),
      )
    }
    check()
    return () => {
      cancelled = true
    }
  }, [pathname])

  const handleEnable = useCallback(async () => {
    setLoading(true)
    try {
      // Same flow (and, critically, same SW scope) as PushToggle — see the
      // scope-'/' double-registration incident noted in push-toggle.tsx.
      const registration = await navigator.serviceWorker.register(
        PORTAL_SW_PATH,
        { scope: PORTAL_SW_SCOPE },
      )
      await navigator.serviceWorker.ready

      const keyRes = await fetch('/api/portal/push')
      if (!keyRes.ok) throw new Error('Push not configured on server')
      const { publicKey } = await keyRes.json()

      const perm = await Notification.requestPermission()
      if (perm !== 'granted') {
        toast.error(c.denied)
        setShow(false)
        return
      }

      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
      })

      const res = await fetch('/api/portal/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subscription: subscription.toJSON(),
          account_id: accountId,
        }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || c.failed)
      }

      toast.success(c.enabled)
      setShow(false)
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : c.failed)
    } finally {
      setLoading(false)
    }
  }, [accountId, c])

  const handleDismiss = useCallback(() => {
    try {
      localStorage.setItem(PUSH_CARD_DISMISS_KEY, Date.now().toString())
    } catch {
      // localStorage unavailable — dismissal lasts this session only
    }
    setShow(false)
  }, [])

  if (!show || pathname !== '/portal') return null

  return (
    <div className="px-4 sm:px-6 pt-4 lg:hidden">
      <div className="max-w-4xl mx-auto bg-white border rounded-xl shadow-sm p-4 flex items-start gap-3">
        <div className="w-10 h-10 rounded-lg bg-blue-600 flex items-center justify-center shrink-0">
          <Bell className="h-5 w-5 text-white" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-zinc-900">{c.title}</p>
          <p className="text-xs text-zinc-500 mt-0.5">{c.body}</p>
          <button
            onClick={handleEnable}
            disabled={loading}
            className="mt-3 flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white text-xs font-medium rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-60"
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Bell className="h-3.5 w-3.5" />
            )}
            {c.enable}
          </button>
        </div>
        <button
          onClick={handleDismiss}
          className="p-1 text-zinc-400 hover:text-zinc-600 shrink-0"
          aria-label={c.close}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
