'use client'

import { useState, useEffect } from 'react'
import { usePathname } from 'next/navigation'
import { Smartphone, Share, X } from 'lucide-react'
import { useLocale } from '@/lib/portal/use-locale'

const DISMISS_KEY = 'dashboard-install-dismissed'

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia('(display-mode: standalone)').matches
    || (window.navigator as Navigator & { standalone?: boolean }).standalone === true
}

export function DashboardInstallBanner() {
  const pathname = usePathname()
  const { t } = useLocale()
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (pathname !== '/portal') return
    if (isStandalone()) return
    if (localStorage.getItem(DISMISS_KEY)) return
    setVisible(true)
  }, [pathname])

  if (pathname !== '/portal' || !visible) return null

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, Date.now().toString())
    setVisible(false)
  }

  return (
    <div className="px-4 sm:px-6 lg:px-8 pt-4">
      <div className="max-w-4xl mx-auto bg-white border rounded-xl shadow-sm p-4 flex items-start gap-3">
        <div className="w-10 h-10 rounded-lg bg-red-600 flex items-center justify-center shrink-0">
          <Smartphone className="h-5 w-5 text-white" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-zinc-900">{t('installBanner.title')}</p>
          <p className="text-xs text-zinc-500 mt-0.5">{t('installBanner.intro')}</p>
          <ul className="text-xs text-zinc-600 mt-2 space-y-1">
            <li className="flex items-start gap-1.5">
              <Share className="h-3.5 w-3.5 inline text-blue-500 mt-0.5 shrink-0" />
              <span>{t('installBanner.iphone')}</span>
            </li>
            <li className="flex items-start gap-1.5">
              <span className="text-zinc-400 shrink-0">⋮</span>
              <span>{t('installBanner.android')}</span>
            </li>
          </ul>
          <button
            onClick={dismiss}
            className="mt-3 text-xs font-medium text-blue-600 hover:text-blue-700"
          >
            {t('installBanner.question')} {t('installBanner.discard')}
          </button>
        </div>
        <button
          onClick={dismiss}
          className="p-1 text-zinc-400 hover:text-zinc-600 shrink-0"
          aria-label={t('installBanner.close')}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
