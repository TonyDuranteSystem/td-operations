import { Building2, ArrowRight } from 'lucide-react'

const COPY = {
  en: {
    title: 'Set up your new company',
    descWithName: (name: string) => `Provide the details for ${name} so we can begin forming it.`,
    descNoName: 'Provide your company details so we can begin forming your new company.',
    cta: 'Continue Setup',
  },
  it: {
    title: 'Configura la tua nuova azienda',
    descWithName: (name: string) => `Inserisci i dati per ${name} così possiamo iniziare a costituirla.`,
    descNoName: 'Inserisci i dati della tua azienda così possiamo iniziare a costituirla.',
    cta: 'Continua',
  },
}

interface FormationInProgressBannerProps {
  leadId: string
  /** Optional company-name choice to personalize the copy. */
  companyName?: string | null
  locale: 'en' | 'it'
}

export function FormationInProgressBanner({ leadId, companyName, locale }: FormationInProgressBannerProps) {
  const c = COPY[locale] ?? COPY.en
  const desc = companyName ? c.descWithName(companyName) : c.descNoName

  return (
    <div className="flex items-center gap-3 bg-emerald-50 border border-emerald-300 rounded-xl px-4 py-3">
      <div className="w-8 h-8 rounded-lg bg-emerald-100 flex items-center justify-center shrink-0">
        <Building2 className="h-4 w-4 text-emerald-700" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-emerald-900">{c.title}</p>
        <p className="text-xs text-emerald-700 mt-0.5">{desc}</p>
      </div>
      <a
        href={`/portal/wizard?lead=${encodeURIComponent(leadId)}`}
        className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 text-white text-xs font-medium rounded-lg hover:bg-emerald-700 transition-colors shrink-0"
      >
        {c.cta}
        <ArrowRight className="h-3.5 w-3.5" />
      </a>
    </div>
  )
}
