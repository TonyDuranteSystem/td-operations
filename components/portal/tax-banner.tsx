import { AlertTriangle, ArrowRight } from 'lucide-react'

interface TaxBannerProps {
  taxYear: number
  returnType: string | null
  locale: 'en' | 'it'
}

/**
 * Non-dismissible banner shown on the portal dashboard when a client
 * has a pending tax return that requires their data submission.
 * Stays visible until data_received = true on the tax_returns record.
 */
export function TaxBanner({ taxYear, returnType, locale }: TaxBannerProps) {
  const returnLabel = returnType || 'Tax Return'

  const title = locale === 'it'
    ? `Azione richiesta: Completa le informazioni fiscali per il ${taxYear}`
    : `Action required: Complete your tax information for ${taxYear}`

  const description = locale === 'it'
    ? `La tua dichiarazione ${returnLabel} per il ${taxYear} richiede i tuoi dati finanziari. Compila il modulo ora per evitare ritardi nella presentazione.`
    : `Your ${returnLabel} for ${taxYear} requires your financial data. Complete the form now to avoid filing delays.`

  const cta = locale === 'it' ? 'Compila il modulo fiscale' : 'Complete tax form'

  return (
    <a
      href="/portal/wizard?type=tax"
      className="block w-full rounded-xl border-2 border-amber-400 bg-amber-50 px-5 py-4 transition-all hover:bg-amber-100 hover:shadow-md mb-6"
    >
      <div className="flex items-start gap-4">
        <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-100 border border-amber-300">
          <AlertTriangle className="h-5 w-5 text-amber-600" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-amber-900 text-sm sm:text-base">{title}</p>
          <p className="text-amber-700 text-xs sm:text-sm mt-1">{description}</p>
        </div>
        <div className="shrink-0 flex items-center gap-1.5 self-center rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700">
          {cta}
          <ArrowRight className="h-3.5 w-3.5" />
        </div>
      </div>
    </a>
  )
}
