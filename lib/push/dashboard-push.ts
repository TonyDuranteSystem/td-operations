/**
 * Dashboard (staff) web-push subscription — the ONE implementation.
 *
 * Three places used to hand-roll the same register → VAPID key → permission →
 * subscribe → POST sequence (DashboardPushToggle, the portal-chats
 * enableNotifications handler, and a copy of urlBase64ToUint8Array in the
 * portal push toggle). They had already drifted (different error handling, a
 * broken notification icon path). Any future dashboard push entry point must
 * call subscribeToDashboardPush() instead of re-rolling the sequence.
 *
 * Client-side only: relies on navigator.serviceWorker / PushManager /
 * Notification. Safe to import from server code as long as the functions are
 * only CALLED in the browser.
 */

export const DASHBOARD_SW_PATH = '/dashboard-sw.js'
export const ADMIN_PUSH_ENDPOINT = '/api/admin/push'

/** Decode a base64url VAPID public key into the byte array PushManager wants. */
export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  const outputArray = new Uint8Array(rawData.length)
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i)
  }
  return outputArray
}

export type DashboardPushResult = 'subscribed' | 'unsupported' | 'unconfigured' | 'denied'

/**
 * Register the dashboard service worker and subscribe this browser to staff
 * push notifications. Returns a discriminated result for the non-error
 * outcomes; throws only on a real failure (subscribe/save error).
 *
 * Order matters and mirrors the original DashboardPushToggle flow:
 * register SW → fetch VAPID key (so "unconfigured" is reported without
 * bothering the user for permission) → request permission → subscribe → save.
 */
export async function subscribeToDashboardPush(): Promise<DashboardPushResult> {
  if (
    typeof navigator === 'undefined' || !('serviceWorker' in navigator) ||
    typeof window === 'undefined' || !('PushManager' in window) ||
    typeof Notification === 'undefined'
  ) {
    return 'unsupported'
  }

  const registration = await navigator.serviceWorker.register(DASHBOARD_SW_PATH)
  await navigator.serviceWorker.ready

  const keyRes = await fetch(ADMIN_PUSH_ENDPOINT)
  if (!keyRes.ok) return 'unconfigured'
  const { publicKey } = await keyRes.json()
  if (!publicKey) return 'unconfigured'

  const perm = await Notification.requestPermission()
  if (perm !== 'granted') return 'denied'

  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
  })

  const res = await fetch(ADMIN_PUSH_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription: subscription.toJSON() }),
  })
  if (!res.ok) throw new Error('Failed to save subscription')

  return 'subscribed'
}
