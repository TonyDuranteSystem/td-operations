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
 * Which service worker the subscription belongs to. The default is the CRM dashboard worker, exactly as
 * before. TD Talk (the standalone Team Chat app, dev job c1e326dd) passes its own worker and scope so its
 * subscription belongs to ITS worker — without this the helper would register the CRM worker and the TD Talk
 * app would never receive a push of its own. Still ONE implementation: pwa.md rule 5 forbids an inline copy.
 */
export interface PushTarget {
  swPath?: string
  scope?: string
}

/** Resolve once this specific registration has an active worker (`serviceWorker.ready` answers for whichever worker controls the PAGE, which on a first TD Talk load is the CRM's). */
async function waitUntilActive(registration: ServiceWorkerRegistration): Promise<void> {
  if (registration.active) return
  const worker = registration.installing ?? registration.waiting
  if (!worker) return
  await new Promise<void>(resolve => {
    const done = () => { if (worker.state === 'activated') resolve() }
    worker.addEventListener('statechange', done)
    done()
  })
}

/**
 * Register the dashboard service worker and subscribe this browser to staff
 * push notifications. Returns a discriminated result for the non-error
 * outcomes; throws only on a real failure (subscribe/save error).
 *
 * Order matters and mirrors the original DashboardPushToggle flow:
 * register SW → fetch VAPID key (so "unconfigured" is reported without
 * bothering the user for permission) → request permission → subscribe → save.
 */
export async function subscribeToDashboardPush(target: PushTarget = {}): Promise<DashboardPushResult> {
  if (
    typeof navigator === 'undefined' || !('serviceWorker' in navigator) ||
    typeof window === 'undefined' || !('PushManager' in window) ||
    typeof Notification === 'undefined'
  ) {
    return 'unsupported'
  }

  const custom = !!(target.swPath || target.scope)
  const swPath = target.swPath ?? DASHBOARD_SW_PATH
  // The CRM's own call stays exactly `register(path)` — an options argument is only added for a scoped worker.
  const registration = target.scope
    ? await navigator.serviceWorker.register(swPath, { scope: target.scope })
    : await navigator.serviceWorker.register(swPath)
  if (custom) await waitUntilActive(registration)
  else await navigator.serviceWorker.ready

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

/**
 * Turn push OFF for one worker (TD Talk's "notifications off"): drop this browser's subscription from the
 * server (scoped to the signed-in user's own device) and from the browser. Returns false when there was
 * nothing to remove or push is not supported.
 */
export async function unsubscribeFromPush(target: PushTarget = {}): Promise<boolean> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return false
  const registration = await navigator.serviceWorker.getRegistration(target.scope ?? '/')
  // getRegistration(url) answers with whichever registration covers that url — with no worker of its own at
  // the scope that is the CRM's, and removing ITS subscription would silently switch the CRM app's push off.
  if (!registration) return false
  if (target.scope && new URL(registration.scope).pathname !== target.scope) return false
  const subscription = await registration.pushManager?.getSubscription()
  if (!subscription) return false
  await fetch(ADMIN_PUSH_ENDPOINT, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  }).catch(() => {})
  return subscription.unsubscribe()
}
