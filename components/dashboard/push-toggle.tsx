'use client'

import { useState, useEffect } from 'react'
import { Bell, BellOff, Loader2, Send } from 'lucide-react'
import { toast } from 'sonner'

// Throttle silent re-subscription to once per 24h per browser. Re-subscribing
// keeps the row warm in admin_push_subscriptions (POST upserts), so endpoints
// that the push service has quietly rotated get refreshed.
const REFRESH_STORAGE_KEY = 'td-admin-push-refreshed-at'
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000

type DashboardPushToggleProps = {
  /**
   * Icon-only rendering (no label, no Test button). Used in the mobile header
   * where horizontal space is tight.
   */
  compact?: boolean
  /**
   * If true and the user already granted permission AND is subscribed, POST the
   * current subscription to /api/admin/push on mount to keep the row fresh.
   * Throttled to once per 24h via localStorage. Should be enabled on exactly
   * ONE instance per dashboard render (we mount it on the desktop header).
   */
  refreshOnMount?: boolean
}

/**
 * Push notification toggle for the CRM dashboard.
 * Allows ALL authenticated dashboard users to subscribe to push notifications.
 * Uses the dashboard service worker and /api/admin/push endpoints.
 */
export function DashboardPushToggle({ compact = false, refreshOnMount = false }: DashboardPushToggleProps = {}) {
  const [supported, setSupported] = useState(false)
  const [permission, setPermission] = useState<NotificationPermission>('default')
  const [subscribed, setSubscribed] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function check() {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        setLoading(false)
        return
      }
      setSupported(true)
      setPermission(Notification.permission)

      try {
        const registration = await navigator.serviceWorker.getRegistration('/dashboard-sw.js')
        if (registration) {
          const sub = await registration.pushManager.getSubscription()
          setSubscribed(!!sub)

          if (refreshOnMount && sub && Notification.permission === 'granted') {
            await maybeRefreshSubscription(sub)
          }
        }
      } catch {
        // Ignore
      }
      setLoading(false)
    }
    check()
  }, [refreshOnMount])

  const handleEnable = async () => {
    setLoading(true)
    try {
      const registration = await navigator.serviceWorker.register('/dashboard-sw.js')
      await navigator.serviceWorker.ready

      const keyRes = await fetch('/api/admin/push')
      if (!keyRes.ok) throw new Error('Push not configured on server')
      const { publicKey } = await keyRes.json()

      const perm = await Notification.requestPermission()
      setPermission(perm)
      if (perm !== 'granted') {
        toast.error('Notification permission denied')
        setLoading(false)
        return
      }

      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
      })

      const res = await fetch('/api/admin/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: subscription.toJSON() }),
      })

      if (!res.ok) throw new Error('Failed to save subscription')

      // Mark the refresh timestamp so refreshOnMount doesn't re-POST today.
      try {
        localStorage.setItem(REFRESH_STORAGE_KEY, String(Date.now()))
      } catch {
        // localStorage unavailable (private mode etc.) — non-fatal.
      }

      setSubscribed(true)
      toast.success('Push notifications enabled')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to enable push')
    } finally {
      setLoading(false)
    }
  }

  const handleDisable = async () => {
    setLoading(true)
    try {
      const registration = await navigator.serviceWorker.getRegistration('/dashboard-sw.js')
      if (registration) {
        const sub = await registration.pushManager.getSubscription()
        if (sub) {
          await fetch('/api/admin/push', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ endpoint: sub.endpoint }),
          })
          await sub.unsubscribe()
        }
      }
      try {
        localStorage.removeItem(REFRESH_STORAGE_KEY)
      } catch {
        // non-fatal
      }
      setSubscribed(false)
      toast.success('Push notifications disabled')
    } catch {
      toast.error('Failed to disable push')
    } finally {
      setLoading(false)
    }
  }

  const handleTest = async () => {
    try {
      const res = await fetch('/api/admin/push/test', { method: 'POST' })
      const data = await res.json()
      if (data.sent > 0) {
        toast.success('Test notification sent!')
      } else {
        toast.error('No active subscriptions found')
      }
    } catch {
      toast.error('Failed to send test')
    }
  }

  if (!supported) return null
  if (loading) {
    return compact ? null : <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
  }

  if (compact) {
    const onClick = subscribed ? handleDisable : handleEnable
    const Icon = subscribed ? Bell : BellOff
    const title =
      permission === 'denied'
        ? 'Notifications blocked in browser settings'
        : subscribed
          ? 'Disable push notifications'
          : 'Enable push notifications'
    return (
      <button
        onClick={onClick}
        disabled={loading || permission === 'denied'}
        className={`p-2 rounded-md transition-colors ${
          subscribed
            ? 'text-emerald-600 hover:bg-emerald-50'
            : permission === 'denied'
              ? 'text-zinc-300 cursor-not-allowed'
              : 'text-zinc-500 hover:bg-zinc-100'
        }`}
        title={title}
        aria-label={title}
      >
        <Icon className="h-5 w-5" />
      </button>
    )
  }

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={subscribed ? handleDisable : handleEnable}
        disabled={loading || permission === 'denied'}
        className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md transition-colors ${
          subscribed
            ? 'bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100'
            : permission === 'denied'
              ? 'bg-zinc-100 text-zinc-400 cursor-not-allowed'
              : 'bg-zinc-100 text-zinc-600 border border-zinc-200 hover:bg-zinc-200'
        }`}
        title={
          permission === 'denied'
            ? 'Notifications blocked in browser settings'
            : subscribed
              ? 'Disable push notifications'
              : 'Enable push notifications'
        }
      >
        {subscribed ? (
          <Bell className="h-3.5 w-3.5" />
        ) : (
          <BellOff className="h-3.5 w-3.5" />
        )}
        {subscribed ? 'Notifications On' : permission === 'denied' ? 'Blocked' : 'Enable Notifications'}
      </button>
      {subscribed && (
        <button
          onClick={handleTest}
          className="flex items-center gap-1 px-2 py-1.5 text-xs rounded-md border border-zinc-200 text-zinc-500 hover:bg-zinc-50 transition-colors"
          title="Send a test notification"
        >
          <Send className="h-3 w-3" />
          Test
        </button>
      )}
    </div>
  )
}

async function maybeRefreshSubscription(sub: PushSubscription) {
  // Throttle: only re-POST if more than REFRESH_INTERVAL_MS has passed.
  try {
    const last = Number(localStorage.getItem(REFRESH_STORAGE_KEY) || '0')
    if (last && Date.now() - last < REFRESH_INTERVAL_MS) return
  } catch {
    // localStorage unavailable — skip throttle, proceed once.
  }

  try {
    const res = await fetch('/api/admin/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub.toJSON() }),
    })
    if (res.ok) {
      try {
        localStorage.setItem(REFRESH_STORAGE_KEY, String(Date.now()))
      } catch {
        // non-fatal
      }
    }
  } catch {
    // Network failure — silent. Next mount will retry.
  }
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  const outputArray = new Uint8Array(rawData.length)
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i)
  }
  return outputArray
}
