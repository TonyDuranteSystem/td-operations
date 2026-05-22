import { Tag, ArrowRight } from 'lucide-react'

const COPY = {
  en: {
    title: 'You have an offer waiting for you',
    desc: 'We prepared a proposal for you. Review it and proceed when you\'re ready.',
    cta: 'View Offer',
  },
  it: {
    title: 'Hai un\'offerta che ti aspetta',
    desc: 'Abbiamo preparato una proposta per te. Leggila e procedi quando sei pronto.',
    cta: 'Visualizza Offerta',
  },
}

interface OfferBannerProps {
  offerUrl: string
  locale: 'en' | 'it'
}

export function OfferBanner({ offerUrl, locale }: OfferBannerProps) {
  const c = COPY[locale] ?? COPY.en

  return (
    <div className="flex items-center gap-3 bg-blue-50 border border-blue-300 rounded-xl px-4 py-3">
      <div className="w-8 h-8 rounded-lg bg-blue-100 flex items-center justify-center shrink-0">
        <Tag className="h-4 w-4 text-blue-700" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-blue-900">{c.title}</p>
        <p className="text-xs text-blue-700 mt-0.5">{c.desc}</p>
      </div>
      <a
        href={offerUrl}
        className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white text-xs font-medium rounded-lg hover:bg-blue-700 transition-colors shrink-0"
      >
        {c.cta}
        <ArrowRight className="h-3.5 w-3.5" />
      </a>
    </div>
  )
}
