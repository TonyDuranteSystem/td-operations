import { Users, ArrowRight } from 'lucide-react'

const COPY = {
  en: {
    title: 'Member information required',
    desc: 'Please complete your LLC member information to finalize your company setup.',
    cta: 'Complete Now',
  },
  it: {
    title: 'Informazioni sui soci richieste',
    desc: 'Dovrai aggiungere gli altri soci della tua LLC per completare la configurazione.',
    cta: 'Completa Ora',
  },
}

interface MemberInfoBannerProps {
  formUrl: string
  locale: 'en' | 'it'
}

export function MemberInfoBanner({ formUrl, locale }: MemberInfoBannerProps) {
  const c = COPY[locale] ?? COPY.en

  return (
    <div className="flex items-center gap-3 bg-red-50 border border-red-300 rounded-xl px-4 py-3">
      <div className="w-8 h-8 rounded-lg bg-red-100 flex items-center justify-center shrink-0">
        <Users className="h-4 w-4 text-red-700" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-red-900">{c.title}</p>
        <p className="text-xs text-red-700 mt-0.5">{c.desc}</p>
      </div>
      <a
        href={formUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-1.5 px-3 py-1.5 bg-red-600 text-white text-xs font-medium rounded-lg hover:bg-red-700 transition-colors shrink-0"
      >
        {c.cta}
        <ArrowRight className="h-3.5 w-3.5" />
      </a>
    </div>
  )
}
