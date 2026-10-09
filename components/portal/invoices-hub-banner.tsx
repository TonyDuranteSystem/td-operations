'use client'

import { useEffect, useState } from 'react'
import { Receipt, ArrowRight, X } from 'lucide-react'
import Link from 'next/link'

// Same key the menu NEW tag uses: opening the invoices page once clears both the tag and this banner.
export const INVOICES_NEW_KEY = 'td-invoices-hub-new-v1'

const COPY = {
  en: {
    title: 'New: Customers & Invoices',
    desc: 'Send invoices, set up repeat billing, and see who has paid. Take the 1-minute tour.',
    cta: 'Open it',
    dismiss: 'Dismiss',
  },
  it: {
    title: 'Novità: Clienti e Fatture',
    desc: 'Invia fatture, imposta fatturazione ricorrente e controlla chi ha pagato. Fai il tour di 1 minuto.',
    cta: 'Aprila',
    dismiss: 'Chiudi',
  },
}

/**
 * Prominent green announcement at the top of the portal home for companies that have the new invoices screen.
 * The parent only renders it when the hub is on for the company and the user is the account admin. It goes away for
 * good (per browser) once the person opens the invoices page or closes it.
 */
export function InvoicesHubBanner({ locale }: { locale: 'en' | 'it' }) {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    try {
      if (!localStorage.getItem(INVOICES_NEW_KEY)) setVisible(true)
    } catch {
      // localStorage unavailable: skip the banner
    }
  }, [])

  const clear = () => {
    try {
      localStorage.setItem(INVOICES_NEW_KEY, '1')
    } catch {
      // no-op
    }
    setVisible(false)
  }

  if (!visible) return null
  const c = COPY[locale] ?? COPY.en

  return (
    <div
      data-testid="invoices-hub-banner"
      className="flex items-center gap-3 bg-emerald-50 border-2 border-emerald-500 rounded-xl px-4 py-3 motion-safe:animate-pulse"
    >
      <div className="w-9 h-9 rounded-lg bg-emerald-100 flex items-center justify-center shrink-0">
        <Receipt className="h-5 w-5 text-emerald-700" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-emerald-950">{c.title}</p>
        <p className="text-xs text-emerald-800 mt-0.5">{c.desc}</p>
      </div>
      <Link
        href="/portal/invoices"
        onClick={clear}
        className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 text-white text-xs font-medium rounded-lg hover:bg-emerald-700 transition-colors shrink-0"
      >
        {c.cta}
        <ArrowRight className="h-3.5 w-3.5" />
      </Link>
      <button onClick={clear} aria-label={c.dismiss} className="p-1 text-emerald-500 hover:text-emerald-700 transition-colors shrink-0">
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}
