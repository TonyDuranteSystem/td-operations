'use client'

import { useState, useEffect, useCallback } from 'react'
import { X, Download, Share } from 'lucide-react'

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

const DISMISS_KEY = 'pwa-install-dismissed'
const DISMISS_DAYS = 30

function isDismissed(): boolean {
  if (typeof window === 'undefined') return true
  const dismissed = localStorage.getItem(DISMISS_KEY)
  if (!dismissed) return false
  const dismissedAt = parseInt(dismissed, 10)
  const daysSince = (Date.now() - dismissedAt) / (1000 * 60 * 60 * 24)
  return daysSince < DISMISS_DAYS
}

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia('(display-mode: standalone)').matches
    || (window.navigator as Navigator & { standalone?: boolean }).standalone === true
}

function isIOS(): boolean {
  if (typeof window === 'undefined') return false
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !(window as Window & { MSStream?: unknown }).MSStream
}

function isMobile(): boolean {
  if (typeof window === 'undefined') return false
  return /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
    || window.innerWidth < 768
}

export function PwaInstallPrompt() {
  const [show, setShow] = useState(false)
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [showIOS, setShowIOS] = useState(false)

  useEffect(() => {
    // Don't show if already installed, not mobile, or recently dismissed
    if (isStandalone() || !isMobile() || isDismissed()) return

    // iOS: show custom instructions
    if (isIOS()) {
      const timer = setTimeout(() => setShowIOS(true), 3000)
      return () => clearTimeout(timer)
    }

    // Android/Chrome: intercept beforeinstallprompt
    const handler = (e: Event) => {
      e.preventDefault()
      setDeferredPrompt(e as BeforeInstallPromptEvent)
      setTimeout(() => setShow(true), 3000)
    }

    window.addEventListener('beforeinstallprompt', handler)
    return () => window.removeEventListener('beforeinstallprompt', handler)
  }, [])

  const handleInstall = useCallback(async () => {
    if (!deferredPrompt) return
    await deferredPrompt.prompt()
    const { outcome } = await deferredPrompt.userChoice
    if (outcome === 'accepted') {
      setShow(false)
    }
    setDeferredPrompt(null)
  }, [deferredPrompt])

  const handleDismiss = useCallback(() => {
    setShow(false)
    setShowIOS(false)
    localStorage.setItem(DISMISS_KEY, Date.now().toString())
  }, [])

  // Android/Chrome install banner
  if (show && deferredPrompt) {
    return (
      <div className="fixed bottom-20 left-4 right-4 z-50 animate-in slide-in-from-bottom-4 duration-300">
        <div className="bg-white rounded-2xl shadow-2xl border border-zinc-200 p-4 flex items-center gap-3">
          <div className="w-12 h-12 rounded-xl bg-red-600 flex items-center justify-center shrink-0">
            <span className="text-white font-bold text-lg">TD</span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-zinc-900">Install TD Portal</p>
            <p className="text-xs text-zinc-500">Quick access from your home screen</p>
          </div>
          <button
            onClick={handleInstall}
            className="px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700 transition-colors shrink-0"
          >
            <Download className="h-4 w-4 inline mr-1" />
            Install
          </button>
          <button
            onClick={handleDismiss}
            className="p-1 text-zinc-400 hover:text-zinc-600 shrink-0"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    )
  }

  // iOS custom instructions
  if (showIOS) {
    return (
      <div className="fixed bottom-20 left-4 right-4 z-50 animate-in slide-in-from-bottom-4 duration-300">
        <div className="bg-white rounded-2xl shadow-2xl border border-zinc-200 p-4">
          <div className="flex items-start gap-3">
            <div className="w-12 h-12 rounded-xl bg-red-600 flex items-center justify-center shrink-0">
              <span className="text-white font-bold text-lg">TD</span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-zinc-900">Install TD Portal</p>
              <p className="text-xs text-zinc-500 mt-1">
                Tap <Share className="h-3.5 w-3.5 inline text-blue-500 -mt-0.5" /> then <strong>&quot;Add to Home Screen&quot;</strong>
              </p>
            </div>
            <button
              onClick={handleDismiss}
              className="p-1 text-zinc-400 hover:text-zinc-600 shrink-0"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="mt-2 flex justify-center">
            <svg className="h-6 w-6 text-zinc-400 animate-bounce" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 5v14M5 12l7 7 7-7" />
            </svg>
          </div>
        </div>
      </div>
    )
  }

  return null
}
