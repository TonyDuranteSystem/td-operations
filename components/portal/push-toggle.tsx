'use client'

import { useState, useEffect } from 'react'
import { Bell, BellOff, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

interface PushToggleProps {
  accountId: string
}

export function PushToggle({ accountId }: PushToggleProps) {
  const [supported, setSupported] = useState(false)
  const [permission, setPermission] = useState<NotificationPermission>('default')
  const [subscribed, setSubscribed] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function check() {
      // Check browser support
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        setLoading(false)
        return
      }
      setSupported(true)
      setPermission(Notification.permission)

      // Check if already subscribed
      try {
        const registration = await navigator.serviceWorker.getRegistration('/portal-sw.js')
        if (registration) {
          const sub = await registration.pushManager.getSubscription()
          setSubscribed(!!sub)
        }
      } catch {
        // Ignore errors
      }
      setLoading(false)
    }
    check()
  }, [])

  const handleEnable = async () => {
    setLoading(true)
    try {
      // Register service worker
      const registration = await navigator.serviceWorker.register('/portal-sw.js')
      await navigator.serviceWorker.ready

      // Get VAPID public key
      const keyRes = await fetch('/api/portal/push')
      if (!keyRes.ok) throw new Error('Push not configured on server')
      const { publicKey } = await keyRes.json()

      // Request permission
      const perm = await Notification.requestPermission()
      setPermission(perm)
      if (perm !== 'granted') {
        toast.error('Notification permission denied')
        setLoading(false)
        return
      }

      // Subscribe
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
      })

      // Save to server
      const res = await fetch('/api/portal/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subscription: subscription.toJSON(),
          account_id: accountId,
        }),
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
      const registration = await navigator.serviceWorker.getRegistration('/portal-sw.js')
      if (registration) {
        const sub = await registration.pushManager.getSubscription()
        if (sub) {
          await fetch('/api/portal/push', {
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

  if (!supported) return null
  if (loading) return <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />

  return (
    <button
      onClick={subscribed ? handleDisable : handleEnable}
      disabled={loading || permission === 'denied'}
      className={`flex items-center gap-2 px-4 py-2.5 text-sm rounded-lg transition-colors ${
        subscribed
          ? 'bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100'
          : permission === 'denied'
            ? 'bg-zinc-100 text-zinc-400 cursor-not-allowed'
            : 'bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100'
      }`}
    >
      {subscribed ? (
        <>
          <Bell className="h-4 w-4" />
          Push notifications on
        </>
      ) : permission === 'denied' ? (
        <>
          <BellOff className="h-4 w-4" />
          Notifications blocked by browser
        </>
      ) : (
        <>
          <Bell className="h-4 w-4" />
          Enable push notifications
        </>
      )}
    </button>
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
