'use client'

import { useState, useEffect } from 'react'
import { Bell, BellOff, Loader2, Send } from 'lucide-react'
import { toast } from 'sonner'

/**
 * Push notification toggle for the CRM dashboard.
 * Allows ALL authenticated dashboard users to subscribe to push notifications.
 * Uses the dashboard service worker and /api/admin/push endpoints.
 */
export function DashboardPushToggle() {
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
        }
      } catch {
        // Ignore
      }
      setLoading(false)
    }
    check()
  }, [])

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
  if (loading) return <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />

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
