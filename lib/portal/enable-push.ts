/**
 * Portal push-enable flow — extracted verbatim from the retired
 * EnablePushCard (Phase 3 consolidation, dev job 8f38add1) so the fixed
 * install-nudge banner reuses the exact council-hardened sequence instead
 * of re-rolling it. Browser-only: call from a client component.
 */

import { urlBase64ToUint8Array } from '@/lib/push/dashboard-push'
import { PORTAL_SW_PATH, PORTAL_SW_SCOPE } from '@/lib/portal/sw-scope'

// Flat shape (not a discriminated union): the repo compiles with
// strict:false, where boolean-literal narrowing doesn't discriminate.
export interface EnablePushResult {
  ok: boolean
  reason?: 'denied' | 'failed'
  message?: string
}

export async function enablePortalPush(accountId: string): Promise<EnablePushResult> {
  try {
    // Permission FIRST, before any await: iOS WebKit ties the prompt to the
    // tap's transient activation, which network awaits can outlive — and the
    // installed iOS app is the only place the push stage renders (council
    // review, senior-engineer major #2). Nothing before this needs the
    // permission.
    const perm = await Notification.requestPermission()
    if (perm !== 'granted') {
      return { ok: false, reason: 'denied' }
    }

    // Same flow (and, critically, same SW scope) as PushToggle — see the
    // scope-'/' double-registration incident noted in push-toggle.tsx.
    const registration = await navigator.serviceWorker.register(
      PORTAL_SW_PATH,
      { scope: PORTAL_SW_SCOPE },
    )
    await navigator.serviceWorker.ready

    const keyRes = await fetch('/api/portal/push')
    if (!keyRes.ok) return { ok: false, reason: 'failed' }
    const { publicKey } = await keyRes.json()

    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
    })

    let res: Response
    try {
      res = await fetch('/api/portal/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subscription: subscription.toJSON(),
          account_id: accountId,
        }),
      })
    } catch {
      // Save failed: drop the browser-side subscription, or the visibility
      // check would see it and hide the nudge forever while the server has no
      // row — the device would silently keep getting emails (council review,
      // senior-engineer major #1).
      await subscription.unsubscribe().catch(() => {})
      return { ok: false, reason: 'failed' }
    }
    if (!res.ok) {
      await subscription.unsubscribe().catch(() => {})
      const d = await res.json().catch(() => ({}))
      return { ok: false, reason: 'failed', message: typeof d.error === 'string' ? d.error : undefined }
    }

    return { ok: true }
  } catch {
    return { ok: false, reason: 'failed' }
  }
}
