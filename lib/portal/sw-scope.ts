/**
 * The ONE canonical service-worker scope for the client portal.
 *
 * Every call site that registers or looks up /portal-sw.js MUST use this
 * constant. Council review 2026-07-21 (dev job 454514f5) found that
 * components/portal/push-toggle.tsx registered the same script with no scope,
 * defaulting to '/'. That produced a SECOND, independent registration which:
 *   - was never returned by useSwUpdate's registration ref, so it got no update
 *     poll and never received SKIP_WAITING (its worker could sit in "waiting"
 *     indefinitely), and
 *   - controlled /portal — the manifest start_url, which is OUTSIDE '/portal/' —
 *     so the app's own launch URL was served by a worker nobody was updating.
 *
 * Note the scope deliberately keeps its trailing slash: it is NOT changed to
 * cover the '/portal' start_url, because changing an existing registration's
 * scope creates a new registration and orphans the old one still in control.
 * With the worker no longer caching anything, an uncontrolled launch URL costs
 * only the offline fallback screen at cold launch — an acceptable trade.
 */
export const PORTAL_SW_SCOPE = '/portal/'

/** The portal service worker script path. */
export const PORTAL_SW_PATH = '/portal-sw.js'

/**
 * Delete every Cache Storage bucket for this origin. Best-effort and always
 * resolves — a purge failure must never block the caller (it is used on the
 * sign-out path).
 *
 * The current portal worker caches nothing, so on an up-to-date device this is
 * a no-op. It exists for devices still carrying a bucket written by a pre-
 * 2026-07-21 worker, which held authenticated portal HTML that survived logout.
 */
export async function purgeAllCaches(): Promise<void> {
  try {
    if (typeof caches === 'undefined') return
    const names = await caches.keys()
    await Promise.all(names.map((name) => caches.delete(name)))
  } catch {
    // Storage unavailable (private mode, unsupported browser) — nothing to do.
  }
}

/**
 * Remove any portal service-worker registration whose scope is not the canonical
 * one — i.e. the stray scope-'/' registration that push-toggle used to create.
 * Best-effort; runs only where page JS is alive.
 */
export async function unregisterStrayPortalWorkers(): Promise<void> {
  try {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
    const regs = await navigator.serviceWorker.getRegistrations()
    await Promise.all(
      regs
        .filter((reg) => {
          if (!reg.active?.scriptURL.endsWith(PORTAL_SW_PATH)) return false
          return !reg.scope.endsWith(PORTAL_SW_SCOPE)
        })
        .map((reg) => reg.unregister()),
    )
  } catch {
    // Non-fatal: a stray registration now runs the same no-cache worker anyway.
  }
}
