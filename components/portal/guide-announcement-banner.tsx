'use client'

import { useEffect, useState } from 'react'
import { Globe, ArrowRight, X } from 'lucide-react'
import Link from 'next/link'

const DISMISS_KEY = 'td-guide-relay-wire-v1'

const COPY = {
  en: {
    title: 'New Guide: How to Send an International Wire',
    desc: 'Learn how to send a SWIFT wire transfer step by step via your Relay account.',
    cta: 'View Guide',
    dismiss: 'Dismiss',
  },
  it: {
    title: 'Nuova Guida: Come Inviare un Bonifico Internazionale',
    desc: 'Scopri come inviare un bonifico SWIFT passo passo tramite il tuo conto Relay.',
    cta: 'Vedi la Guida',
    dismiss: 'Chiudi',
  },
}

export function GuideAnnouncementBanner({ locale }: { locale: 'en' | 'it' }) {
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
    <div className="flex items-center gap-3 bg-blue-50 border border-blue-200 rounded-xl px-4 py-3">
      <div className="w-8 h-8 rounded-lg bg-blue-100 flex items-center justify-center shrink-0">
        <Globe className="h-4 w-4 text-blue-600" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-blue-900">{c.title}</p>
        <p className="text-xs text-blue-700 mt-0.5">{c.desc}</p>
      </div>
      <Link
        href="/portal/guide/relay-wire"
        onClick={handleDismiss}
        className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white text-xs font-medium rounded-lg hover:bg-blue-700 transition-colors shrink-0"
      >
        {c.cta}
        <ArrowRight className="h-3.5 w-3.5" />
      </Link>
      <button
        onClick={handleDismiss}
        aria-label={c.dismiss}
        className="p-1 text-blue-400 hover:text-blue-600 transition-colors shrink-0"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}
