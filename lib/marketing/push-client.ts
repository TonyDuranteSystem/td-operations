/**
 * TD Marketing — turn notifications on / off for this browser (browser only; dev job 9aec66fa, Addendum G). Same steps as the staff helper
 * (lib/push/dashboard-push.ts) but against the marketing endpoint and the marketing worker (scope /marketing): the staff endpoint refuses marketing logins on purpose.
 */
import { urlBase64ToUint8Array } from '@/lib/push/dashboard-push'

export const MARKETING_SW_PATH = '/marketing-sw.js'
export const MARKETING_SCOPE = '/marketing'
export const MARKETING_PUSH_ENDPOINT = '/api/marketing/push'

export type MarketingPushResult = 'subscribed' | 'unsupported' | 'unconfigured' | 'denied'

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

export async function subscribeToMarketingPush(): Promise<MarketingPushResult> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator) || typeof window === 'undefined' || !('PushManager' in window) || typeof Notification === 'undefined') return 'unsupported'
  const registration = await navigator.serviceWorker.register(MARKETING_SW_PATH, { scope: MARKETING_SCOPE })
  await waitUntilActive(registration)
  const keyRes = await fetch(MARKETING_PUSH_ENDPOINT)
  if (!keyRes.ok) return 'unconfigured'
  const { publicKey } = await keyRes.json()
  if (!publicKey) return 'unconfigured'
  const perm = await Notification.requestPermission()
  if (perm !== 'granted') return 'denied'
  const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource })
  const res = await fetch(MARKETING_PUSH_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: subscription.toJSON() }) })
  if (!res.ok) throw new Error('Failed to save subscription')
  return 'subscribed'
}

/** Is this browser already subscribed through the marketing worker? */
export async function hasMarketingPush(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator) || typeof Notification === 'undefined') return false
  const reg = await navigator.serviceWorker.getRegistration(MARKETING_SCOPE)
  if (!reg || new URL(reg.scope).pathname !== MARKETING_SCOPE) return false
  const sub = await reg.pushManager?.getSubscription()
  return !!sub && Notification.permission === 'granted'
}
