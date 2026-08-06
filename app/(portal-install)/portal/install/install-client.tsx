'use client'

/**
 * Client half of the public install page. First paint uses the server's
 * UA/Accept-Language guess; this component refines it (iPadOS desktop-UA,
 * standalone detection, beforeinstallprompt capture with timeout fallback)
 * through the pure resolver in lib/portal/install-page-mode.ts.
 *
 * Council rules honored here (dev job 8f38add1):
 * - iOS ALWAYS shows the "Open in Safari" escape hatch (in-app WebViews are
 *   not reliably detectable; SFSafariViewController never is).
 * - The Android Install button degrades to manual ⋮-menu steps when
 *   beforeinstallprompt hasn't arrived within the timeout — never a dead
 *   button.
 * - ?src= is validated against the enum and parked in sessionStorage for the
 *   Phase-2 events endpoint; invalid values are dropped.
 */

import { useCallback, useEffect, useState } from 'react'
import { Download, Share, Smartphone, CheckCircle2, Copy, MoreVertical } from 'lucide-react'
import {
  resolveInstallPageMode,
  detectDevice,
  isInAppBrowser,
  INSTALL_SRC_STORAGE_KEY,
  type InstallDevice,
  type InstallLanguage,
  type InstallPageMode,
  type InstallPromptState,
  type InstallSrc,
} from '@/lib/portal/install-page-mode'
import { INSTALL_PAGE_COPY } from '@/lib/portal/install-copy'
import { postPwaEvent, postPwaEventOnce, PWA_DEDUP_KEYS } from '@/lib/portal/pwa-events'

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

const PROMPT_TIMEOUT_MS = 2500

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia('(display-mode: standalone)').matches
    || (window.navigator as Navigator & { standalone?: boolean }).standalone === true
}

export function InstallPageClient({
  initialDevice,
  initialLanguage,
  src,
  qrSvg,
  installUrl,
}: {
  initialDevice: InstallDevice
  initialLanguage: InstallLanguage
  src: InstallSrc | null
  qrSvg: string
  installUrl: string
}) {
  const [language, setLanguage] = useState<InstallLanguage>(initialLanguage)
  const [device, setDevice] = useState<InstallDevice>(initialDevice)
  const [standalone, setStandalone] = useState(false)
  const [inApp, setInApp] = useState(false)
  const [promptState, setPromptState] = useState<InstallPromptState>('waiting')
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    // Park the (already-validated) channel tag for Phase-2 attribution.
    if (src) {
      try { sessionStorage.setItem(INSTALL_SRC_STORAGE_KEY, src) } catch { /* private mode */ }
    }

    const ua = navigator.userAgent
    // Client-side refinement: catches iPadOS reporting a Macintosh UA.
    const refinedDevice = detectDevice(ua, {
      platform: navigator.platform,
      maxTouchPoints: navigator.maxTouchPoints,
    })
    setDevice(refinedDevice)
    setInApp(isInAppBrowser(ua))
    setStandalone(isStandalone())

    // Funnel: one page_view per pageload (src carries the channel — this is
    // the visit-level attribution that survives even where installs can't be
    // attributed, D6c). React StrictMode double-mount is dev-only.
    postPwaEvent({ event: 'page_view', ...(src ? { src } : {}), device: refinedDevice })

    // Android fires appinstalled on this very page when the native prompt is
    // accepted — log it with the channel, once per device.
    const onInstalled = () => {
      postPwaEventOnce(PWA_DEDUP_KEYS.installed, {
        event: 'installed',
        device: refinedDevice,
        ...(src ? { src } : {}),
      })
    }
    window.addEventListener('appinstalled', onInstalled)

    const handler = (e: Event) => {
      e.preventDefault()
      setDeferredPrompt(e as BeforeInstallPromptEvent)
      setPromptState('captured')
    }
    window.addEventListener('beforeinstallprompt', handler)
    const timer = setTimeout(() => {
      // Only downgrade if the event still hasn't arrived.
      setPromptState(prev => (prev === 'waiting' ? 'timeout' : prev))
    }, PROMPT_TIMEOUT_MS)
    return () => {
      window.removeEventListener('beforeinstallprompt', handler)
      window.removeEventListener('appinstalled', onInstalled)
      clearTimeout(timer)
    }
  }, [src])

  const mode: InstallPageMode = resolveInstallPageMode({
    device,
    standalone,
    inAppBrowser: inApp,
    installPrompt: promptState,
  })

  const c = INSTALL_PAGE_COPY[language]

  const handleInstall = useCallback(async () => {
    if (!deferredPrompt) return
    await deferredPrompt.prompt()
    const { outcome } = await deferredPrompt.userChoice
    if (outcome === 'accepted') setStandalone(true)
    setDeferredPrompt(null)
    setPromptState('timeout')
  }, [deferredPrompt])

  const handleCopyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(installUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 4000)
    } catch { /* clipboard unavailable — the URL is printed on the page */ }
  }, [installUrl])

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50/30 flex flex-col items-center px-5 py-10">
      {/* Language toggle — detection can be wrong; switching must be one tap. */}
      <div className="w-full max-w-md flex justify-end gap-1 mb-4">
        {(['en', 'it'] as const).map(l => (
          <button
            key={l}
            onClick={() => setLanguage(l)}
            className={`px-2.5 py-1 text-xs font-semibold rounded-full transition-colors ${
              language === l ? 'bg-red-600 text-white' : 'bg-white text-zinc-500 border border-zinc-200'
            }`}
          >
            {l.toUpperCase()}
          </button>
        ))}
      </div>

      <div className="w-full max-w-md">
        {/* Brand + headline */}
        <div className="flex flex-col items-center text-center mb-8">
          <div className="w-16 h-16 rounded-2xl bg-red-600 flex items-center justify-center mb-4 shadow-lg">
            <span className="text-white font-bold text-2xl">TD</span>
          </div>
          <h1 className="text-2xl font-bold text-zinc-900">{c.headline}</h1>
          <p className="text-sm text-zinc-600 mt-2">{c.subline}</p>
        </div>

        {mode === 'installed' && (
          <div className="bg-white rounded-2xl shadow-sm border border-zinc-200 p-6 text-center">
            <CheckCircle2 className="h-10 w-10 text-green-600 mx-auto mb-3" />
            <p className="text-lg font-semibold text-zinc-900">{c.installedTitle}</p>
            <p className="text-sm text-zinc-600 mt-1">{c.installedBody}</p>
            <a
              href="/portal"
              className="inline-block mt-4 px-6 py-2.5 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700 transition-colors"
            >
              {c.installedCta}
            </a>
            <p className="text-xs text-zinc-500 mt-4">{c.installedPushNote}</p>
          </div>
        )}

        {(mode === 'android-prompt' || mode === 'android-waiting') && (
          <div className="bg-white rounded-2xl shadow-sm border border-zinc-200 p-6 text-center">
            <Smartphone className="h-10 w-10 text-red-600 mx-auto mb-3" />
            <button
              onClick={handleInstall}
              disabled={mode === 'android-waiting'}
              className="w-full px-6 py-3.5 bg-red-600 text-white text-base font-semibold rounded-xl hover:bg-red-700 transition-colors disabled:opacity-60"
            >
              <Download className="h-5 w-5 inline mr-2 -mt-0.5" />
              {mode === 'android-waiting' ? c.androidWaiting : c.androidInstall}
            </button>
            <p className="text-xs text-zinc-500 mt-3">{c.loginNote}</p>
          </div>
        )}

        {mode === 'android-manual' && (
          <div className="bg-white rounded-2xl shadow-sm border border-zinc-200 p-6">
            <p className="text-sm font-semibold text-zinc-900 mb-3">
              <MoreVertical className="h-4 w-4 inline text-zinc-500 -mt-0.5" /> {c.androidManualTitle}
            </p>
            <ol className="text-sm text-zinc-600 space-y-2">
              {c.androidManualSteps.map((step, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span className="font-semibold text-zinc-900 shrink-0">{i + 1}.</span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
            <p className="text-xs text-zinc-500 mt-4">{c.loginNote}</p>
          </div>
        )}

        {(mode === 'ios-safari' || mode === 'ios-inapp') && (
          <div className="space-y-4">
            {mode === 'ios-inapp' && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-800">
                {c.iosInAppWarning}
              </div>
            )}
            <div className="bg-white rounded-2xl shadow-sm border border-zinc-200 p-6">
              <p className="text-sm font-semibold text-zinc-900 mb-3">{c.iosTitle}</p>
              <ol className="text-sm text-zinc-600 space-y-3">
                <li className="flex items-start gap-2">
                  <span className="font-semibold text-zinc-900 shrink-0">1.</span>
                  <span>
                    {c.iosStep1Before} <strong>{c.iosStep1Bold}</strong>{' '}
                    <Share className="h-4 w-4 inline text-blue-500 -mt-0.5" /> {c.iosStep1After}
                  </span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="font-semibold text-zinc-900 shrink-0">2.</span>
                  <span>
                    {c.iosStep2Before} <strong>{c.iosStep2Bold}</strong>
                  </span>
                </li>
              </ol>
              <p className="text-xs text-zinc-500 mt-4">{c.loginNote}</p>
            </div>
            {/* ALWAYS visible on iOS (council rule): in-app WebViews are not
                reliably detectable, so the Safari hatch shows unconditionally. */}
            <div className="bg-white rounded-2xl shadow-sm border border-zinc-200 p-5">
              <p className="text-sm font-semibold text-zinc-900">{c.iosHatchTitle}</p>
              <p className="text-xs text-zinc-600 mt-1">{c.iosHatchBody}</p>
              <div className="mt-3 flex items-center gap-2">
                <button
                  onClick={handleCopyLink}
                  className="px-3 py-2 bg-zinc-100 text-zinc-800 text-xs font-medium rounded-lg hover:bg-zinc-200 transition-colors"
                >
                  <Copy className="h-3.5 w-3.5 inline mr-1 -mt-0.5" />
                  {copied ? c.copied : c.copyLink}
                </button>
              </div>
              <p className="text-[11px] text-zinc-400 mt-2 break-all">{installUrl}</p>
            </div>
          </div>
        )}

        {mode === 'desktop' && (
          <div className="bg-white rounded-2xl shadow-sm border border-zinc-200 p-6 text-center">
            <p className="text-sm font-semibold text-zinc-900">{c.desktopTitle}</p>
            <p className="text-xs text-zinc-600 mt-1 mb-4">{c.desktopBody}</p>
            <div
              className="mx-auto w-[220px] h-[220px] rounded-xl border border-zinc-100 overflow-hidden"
              role="img"
              aria-label={c.desktopAlt}
              dangerouslySetInnerHTML={{ __html: qrSvg }}
            />
            <p className="text-[11px] text-zinc-400 mt-3 break-all">{installUrl}</p>
          </div>
        )}

        <p className="text-center text-[11px] text-zinc-400 mt-8">
          Tony Durante LLC · TD Portal
        </p>
      </div>
    </div>
  )
}
