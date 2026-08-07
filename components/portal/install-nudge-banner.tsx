'use client'

/**
 * THE fixed in-portal install/push nudge (Phase 3, dev job 8f38add1).
 *
 * Antonio's spec (2026-08-06, explicit override of the council's
 * dismissible recommendation): NON-DISMISSIBLE — no X, no snooze; it
 * disappears only when this device is installed AND receiving push
 * (resolveInstallNudge returns 'none'). It must never block content:
 * compact in-flow banner above the page, never a modal.
 *
 * Replaces three retired surfaces (floating PwaInstallPrompt,
 * DashboardInstallBanner, EnablePushCard) so a client sees exactly ONE
 * nudge, chosen by the shared brain in lib/portal/install-state.ts:
 *  - 'install' (mobile browser): link → /portal/install?src=portal-nudge
 *  - 'push' (installed, no subscription): one-tap enable via the extracted
 *    council-hardened flow in lib/portal/enable-push.ts
 * Desktop browsers get the sidebar "Get the app" entry instead.
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Bell, BellOff, Loader2, Smartphone } from 'lucide-react'
import { toast } from 'sonner'
import { useLocale } from '@/lib/portal/use-locale'
import { resolveInstallNudge, type InstallNudge } from '@/lib/portal/install-state'
import { enablePortalPush } from '@/lib/portal/enable-push'
import { INSTALL_NUDGE_COPY } from '@/lib/portal/install-copy'
import { PORTAL_SW_SCOPE } from '@/lib/portal/sw-scope'

function isStandalone(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches
    || (window.navigator as Navigator & { standalone?: boolean }).standalone === true
}

function isMobileViewport(): boolean {
  return /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
    || window.innerWidth < 768
    || navigator.maxTouchPoints > 1
}

export function InstallNudgeBanner({ accountId }: { accountId: string }) {
  const { locale } = useLocale()
  const c = INSTALL_NUDGE_COPY[locale === 'it' ? 'it' : 'en']
  const [nudge, setNudge] = useState<InstallNudge>('none')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function check() {
      const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window
      let subscribed = false
      if (pushSupported) {
        try {
          const registration = await navigator.serviceWorker.getRegistration(PORTAL_SW_SCOPE)
          subscribed = !!(await registration?.pushManager.getSubscription())
        } catch { /* treat as unsubscribed */ }
      }
      if (cancelled) return
      setNudge(resolveInstallNudge({
        isMobile: isMobileViewport(),
        standalone: isStandalone(),
        pushSupported,
        // Defensive: don't assume the Notification global exists just
        // because serviceWorker + PushManager do.
        permission: pushSupported && 'Notification' in window
          ? Notification.permission
          : 'denied',
        subscribed,
      }))
    }
    check()
    return () => { cancelled = true }
  }, [])

  const handleEnablePush = useCallback(async () => {
    setLoading(true)
    const result = await enablePortalPush(accountId)
    setLoading(false)
    if (result.ok) {
      toast.success(c.pushEnabled)
      setNudge('none')
      return
    }
    if (result.reason === 'denied') {
      toast.error(c.pushDenied)
      // Permission denied is only fixable in OS settings → switch to the
      // hard-denied NAG stage (Antonio 2026-08-07), not silence.
      setNudge('blocked')
      return
    }
    toast.error(result.message || c.pushFailed)
  }, [accountId, c])

  if (nudge === 'none') return null

  return (
    <div className="px-4 sm:px-6 pt-3">
      <div className="max-w-4xl mx-auto flex items-center gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-2.5">
        {nudge === 'install' ? (
          <>
            <Smartphone className="h-4 w-4 text-red-600 shrink-0" />
            <p className="flex-1 min-w-0 text-xs text-red-900">{c.installLine}</p>
            <Link
              href="/portal/install?src=portal-nudge"
              className="shrink-0 px-3 py-1.5 bg-red-600 text-white text-xs font-semibold rounded-lg hover:bg-red-700 transition-colors"
            >
              {c.installCta}
            </Link>
          </>
        ) : nudge === 'blocked' ? (
          <>
            {/* Hard-denied stage (Antonio 2026-08-07: NAG, not silence).
                No button — the permission is only fixable in OS settings, so
                the line IS the instruction. Non-dismissible like the rest. */}
            <BellOff className="h-4 w-4 text-red-600 shrink-0" />
            <p className="flex-1 min-w-0 text-xs text-red-900">{c.blockedLine}</p>
          </>
        ) : (
          <>
            <Bell className="h-4 w-4 text-red-600 shrink-0" />
            <p className="flex-1 min-w-0 text-xs text-red-900">{c.pushLine}</p>
            <button
              onClick={handleEnablePush}
              disabled={loading}
              className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 bg-red-600 text-white text-xs font-semibold rounded-lg hover:bg-red-700 transition-colors disabled:opacity-60"
            >
              {loading && <Loader2 className="h-3 w-3 animate-spin" />}
              {c.pushCta}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
