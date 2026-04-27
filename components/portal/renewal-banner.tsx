import { FileSignature, ArrowRight } from 'lucide-react'
import Link from 'next/link'

const COPY = {
  en: {
    title: 'Your Annual Agreement is ready to sign',
    desc: 'Review and sign your annual service agreement to confirm your services for this year.',
    cta: 'Review & Sign',
  },
  it: {
    title: 'Il tuo Contratto Annuale è pronto per la firma',
    desc: 'Rivedi e firma il contratto di servizio annuale per confermare i tuoi servizi per quest\'anno.',
    cta: 'Rivedi e Firma',
  },
}

interface RenewalBannerProps {
  token: string
  locale: 'en' | 'it'
}

export function RenewalBanner({ token, locale }: RenewalBannerProps) {
  const c = COPY[locale] ?? COPY.en

  return (
    <div className="flex items-center gap-3 bg-amber-50 border border-amber-300 rounded-xl px-4 py-3">
      <div className="w-8 h-8 rounded-lg bg-amber-100 flex items-center justify-center shrink-0">
        <FileSignature className="h-4 w-4 text-amber-700" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-amber-900">{c.title}</p>
        <p className="text-xs text-amber-700 mt-0.5">{c.desc}</p>
      </div>
      <Link
        href={`/portal/sign?token=${token}`}
        className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-600 text-white text-xs font-medium rounded-lg hover:bg-amber-700 transition-colors shrink-0"
      >
        {c.cta}
        <ArrowRight className="h-3.5 w-3.5" />
      </Link>
    </div>
  )
}
