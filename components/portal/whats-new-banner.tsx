'use client'

import { useEffect, useState } from 'react'
import { Sparkles, X } from 'lucide-react'
import { useLocale } from '@/lib/portal/use-locale'

// Bump the version suffix to re-show the banner to everyone after a major change.
const DISMISS_KEY = 'td-whats-new-v1'

/**
 * One-time (per device) "What's New" announcement on the portal home page.
 * Dismissal is stored in localStorage, mirroring TeamAccessAnnouncementBanner /
 * GuideAnnouncementBanner. The key is read in a useEffect so the server render
 * and first client render agree (no hydration mismatch); the banner only mounts
 * its content after that effect confirms the key is unset.
 */
export function WhatsNewBanner() {
  const { t } = useLocale()
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    try {
      if (!localStorage.getItem(DISMISS_KEY)) setVisible(true)
    } catch {
      // localStorage unavailable — skip banner
    }
  }, [])

  const handleDismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, '1')
    } catch {
      // no-op
    }
    setVisible(false)
  }

  if (!visible) return null

  const bullets = [
    { lead: t('whatsNew.bullet1Lead'), rest: t('whatsNew.bullet1Rest') },
    { lead: t('whatsNew.bullet2Lead'), rest: t('whatsNew.bullet2Rest') },
  ]

  return (
    <div className="relative flex gap-3 bg-gradient-to-r from-blue-50 to-indigo-50 border border-indigo-200 border-l-4 border-l-indigo-400 rounded-xl px-4 py-3.5">
      <div className="w-8 h-8 rounded-lg bg-indigo-100 flex items-center justify-center shrink-0">
        <Sparkles className="h-4 w-4 text-indigo-600" />
      </div>
      <div className="flex-1 min-w-0 pr-6">
        <p className="text-sm font-semibold text-indigo-900">{t('whatsNew.title')}</p>
        <ul className="mt-1.5 space-y-1.5">
          {bullets.map((b, i) => (
            <li key={i} className="flex gap-1.5 text-xs text-indigo-800">
              <span className="select-none text-indigo-400">•</span>
              <span>
                <span className="font-medium">{b.lead}</span>
                {b.rest}
              </span>
            </li>
          ))}
        </ul>
        <button
          onClick={handleDismiss}
          className="mt-3 inline-flex items-center rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-indigo-700"
        >
          {t('whatsNew.cta')}
        </button>
      </div>
      <button
        onClick={handleDismiss}
        aria-label={t('whatsNew.dismiss')}
        className="absolute right-2.5 top-2.5 p-1 text-indigo-400 transition-colors hover:text-indigo-600"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}
