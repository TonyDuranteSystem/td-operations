import { AlertTriangle, ArrowRight, CheckCircle, Clock, Pencil } from 'lucide-react'

interface TaxBannerProps {
  taxYear: number
  returnType: string | null
  locale: 'en' | 'it'
  /** Whether the client's data has been received (wizard submitted + job processed) */
  dataReceived?: boolean
  /** Whether the return has been sent to India for processing (editing locked) */
  sentToIndia?: boolean
}

/**
 * Non-dismissible banner shown on the portal dashboard for active tax returns.
 *
 * Three variants:
 * - State 1 (amber): data_received=false — client needs to complete the form
 * - State 2 (blue + Edit): data_received=true, sent_to_india=false — under review, edits still allowed
 * - State 3 (blue, no Edit): sent_to_india=true — processing in progress, edits locked
 */
export function TaxBanner({ taxYear, returnType, locale, dataReceived = false, sentToIndia = false }: TaxBannerProps) {
  const returnLabel = returnType || 'Tax Return'

  // State 3: sent to India — in progress, no edit
  if (sentToIndia) {
    const title = locale === 'it'
      ? `In elaborazione: ${returnLabel} ${taxYear}`
      : `In progress: ${returnLabel} ${taxYear}`

    const description = locale === 'it'
      ? `I tuoi dati per la ${returnLabel} ${taxYear} sono in fase di elaborazione. Ti contatteremo se avremo bisogno di ulteriori informazioni.`
      : `Your data for ${returnLabel} ${taxYear} is being processed. We'll reach out if we need any additional information.`

    return (
      <div className="block w-full rounded-xl border-2 border-blue-300 bg-blue-50 px-5 py-4 mb-6">
        <div className="flex items-start gap-4">
          <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-100 border border-blue-300">
            <Clock className="h-5 w-5 text-blue-600" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-blue-900 text-sm sm:text-base">{title}</p>
            <p className="text-blue-700 text-xs sm:text-sm mt-1">{description}</p>
          </div>
        </div>
      </div>
    )
  }

  // State 2: data received, under review — edit still allowed
  if (dataReceived) {
    const title = locale === 'it'
      ? `Informazioni fiscali inviate — in revisione (${taxYear})`
      : `Tax information submitted — under review (${taxYear})`

    const description = locale === 'it'
      ? `I tuoi dati per la ${returnLabel} ${taxYear} sono stati inviati e sono in fase di revisione. Puoi ancora modificare le risposte fino all'inizio dell'elaborazione.`
      : `Your data for ${returnLabel} ${taxYear} has been submitted and is under review. You can still edit your answers until processing begins.`

    const cta = locale === 'it' ? 'Modifica invio' : 'Edit submission'

    return (
      <a
        href="/portal/wizard?type=tax"
        className="block w-full rounded-xl border-2 border-blue-300 bg-blue-50 px-5 py-4 transition-all hover:bg-blue-100 hover:shadow-md mb-6"
      >
        <div className="flex items-start gap-4">
          <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-100 border border-blue-300">
            <CheckCircle className="h-5 w-5 text-blue-600" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-blue-900 text-sm sm:text-base">{title}</p>
            <p className="text-blue-700 text-xs sm:text-sm mt-1">{description}</p>
          </div>
          <div className="shrink-0 flex items-center gap-1.5 self-center rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700">
            <Pencil className="h-3.5 w-3.5" />
            {cta}
          </div>
        </div>
      </a>
    )
  }

  // State 1: action required — client needs to complete the form
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
