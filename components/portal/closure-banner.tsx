import Link from 'next/link'
import { AlertCircle, ArrowRight } from 'lucide-react'
import type { PendingClosure } from '@/lib/portal/pending-closures'

/**
 * Home-page card for a Company Closure whose form the client still owes.
 * Replaces the generic sidebar "Completa Registrazione" entry for closures
 * (Antonio, 2026-09-24): the card names WHAT the form is for, so a client
 * whose own company is set up isn't left wondering why they're asked to
 * "complete registration". Rendered only for closures returned by
 * getPendingClosures — it disappears as soon as the form is sent.
 */
const COPY = {
  en: {
    title: 'Complete Registration — Company Closure',
    descNamed: 'We need the details of {name}, the company you are closing.',
    desc: 'We need the details of the company you are closing — name, EIN and Articles of Organization.',
    cta: 'Fill in the form',
  },
  it: {
    title: 'Completa Registrazione — Chiusura Società',
    descNamed: 'Ci servono i dati di {name}, la società che stai chiudendo.',
    desc: 'Ci servono i dati della società che stai chiudendo — nome, EIN e Atto Costitutivo.',
    cta: 'Compila il modulo',
  },
}

interface ClosureBannerProps {
  closure: PendingClosure
  locale: 'en' | 'it'
}

export function ClosureBanner({ closure, locale }: ClosureBannerProps) {
  const c = COPY[locale] ?? COPY.en
  const desc = closure.companyName ? c.descNamed.replace('{name}', closure.companyName) : c.desc

  return (
    <Link
      href={`/portal/wizard?type=closure&sd=${encodeURIComponent(closure.serviceDeliveryId)}`}
      className="flex items-center gap-4 p-5 bg-rose-50 border-2 border-rose-300 rounded-xl hover:bg-rose-100 transition-colors group"
    >
      <div className="h-12 w-12 rounded-xl bg-rose-600 flex items-center justify-center shrink-0">
        <AlertCircle className="h-6 w-6 text-white" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-base font-semibold text-rose-900">{c.title}</p>
        <p className="text-sm text-rose-700 mt-0.5">{desc}</p>
      </div>
      <span className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 bg-rose-600 text-white text-xs font-medium rounded-lg group-hover:bg-rose-700 transition-colors shrink-0">
        {c.cta}
        <ArrowRight className="h-3.5 w-3.5" />
      </span>
      <ArrowRight className="sm:hidden h-5 w-5 text-rose-500 shrink-0" />
    </Link>
  )
}
