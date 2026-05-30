'use client'

import { useEffect, useState } from 'react'
import { Users, ArrowRight, X } from 'lucide-react'
import Link from 'next/link'

// Bump the version suffix to re-show the banner to everyone after a major change.
const DISMISS_KEY = 'td-team-access-announce-v1'

const COPY = {
  en: {
    title: 'New: Invite your team to the portal',
    desc: 'You can now give your colleagues their own portal login and choose exactly what each of them can see.',
    cta: 'See how it works',
    dismiss: 'Dismiss',
  },
  it: {
    title: 'Novità: Invita il tuo team nel portale',
    desc: 'Ora puoi dare ai tuoi collaboratori un accesso personale al portale e scegliere esattamente cosa ciascuno può vedere.',
    cta: 'Scopri come funziona',
    dismiss: 'Chiudi',
  },
}

/**
 * One-time (per device) announcement for Portal Team Access. Rendered ONLY for
 * account-admins (the only users who can invite teammates) — the parent gates on
 * canManageTeam. Dismissal is stored in localStorage, mirroring
 * GuideAnnouncementBanner. Links to the "Invite your team" guide article.
 */
export function TeamAccessAnnouncementBanner({ locale }: { locale: 'en' | 'it' }) {
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

  const c = COPY[locale] ?? COPY.en

  return (
    <div className="flex items-center gap-3 bg-violet-50 border border-violet-200 rounded-xl px-4 py-3">
      <div className="w-8 h-8 rounded-lg bg-violet-100 flex items-center justify-center shrink-0">
        <Users className="h-4 w-4 text-violet-600" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-violet-900">{c.title}</p>
        <p className="text-xs text-violet-700 mt-0.5">{c.desc}</p>
      </div>
      <Link
        href="/portal/guide"
        onClick={handleDismiss}
        className="flex items-center gap-1.5 px-3 py-1.5 bg-violet-600 text-white text-xs font-medium rounded-lg hover:bg-violet-700 transition-colors shrink-0"
      >
        {c.cta}
        <ArrowRight className="h-3.5 w-3.5" />
      </Link>
      <button
        onClick={handleDismiss}
        aria-label={c.dismiss}
        className="p-1 text-violet-400 hover:text-violet-600 transition-colors shrink-0"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}
