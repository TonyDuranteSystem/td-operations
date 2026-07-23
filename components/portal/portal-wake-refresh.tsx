'use client'

import { usePathname, useRouter } from 'next/navigation'
import { useWakeSignal } from '@/lib/hooks/use-wake-signal'

/**
 * Re-renders the current portal route from the server when the client returns
 * to the app. Renders nothing.
 *
 * ── WHY THIS IS THE WHOLE PORTAL ANSWER ────────────────────────────────────
 * The client portal is server-rendered — there is no client-side query cache to
 * invalidate. `router.refresh()` re-runs the layout AND the page on the server,
 * so ONE call brings Documents, Sign Documents, Invoices, My Company, Addresses
 * and the sidebar counts up to date at once. It is the exact call
 * components/portal/pull-to-refresh.tsx already makes on pull-down; the only new
 * thing here is the trigger. Nothing is invented.
 *
 * ── WHAT IT DELIBERATELY DOES NOT TOUCH ────────────────────────────────────
 * SIGNING ROUTES. A refresh re-runs the page's server code, and those pages
 * decide what to render from a fresh DB read — so a transient error, or a staff
 * action mid-session, can flip the branch and replace an open signing document
 * with "no agreement found" or "you have already signed", WHILE THE CLIENT IS
 * SIGNING. Nothing on a signing page goes usefully stale anyway: its content is
 * one document the client is actively working through.
 *
 * (The refresh itself is safe for ordinary client state — React reconciles, it
 * does not remount, so a half-typed message, an open modal and an in-flight
 * upload all survive; the ~24 existing post-mutation router.refresh() calls in
 * components/portal/* rely on exactly that. The hazard is a server-side BRANCH
 * flip, which is why the exclusion is by route rather than a blanket ban.)
 *
 * ── COST, STATED HONESTLY ──────────────────────────────────────────────────
 * One wake re-runs the portal layout: roughly a dozen awaited steps, and the
 * nav-visibility check alone is ~10 queries — call it ~15 before the page's own.
 * That is why useWakeSignal gates on "actually away for 20s+" rather than
 * firing on every glance, and throttles what remains.
 */
const NEVER_REFRESH_PREFIXES = ['/portal/sign']

export function PortalWakeRefresh() {
  const router = useRouter()
  const pathname = usePathname()

  const onSigningRoute = NEVER_REFRESH_PREFIXES.some(p => pathname?.startsWith(p))

  useWakeSignal({
    enabled: !onSigningRoute,
    onWake: () => router.refresh(),
  })

  return null
}
