'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, ArrowRight, CheckCircle, Clock, Pencil, Loader2 } from 'lucide-react'
import type { ReviewStatus } from '@/lib/tax/review-status'

interface TaxBannerProps {
  taxYear: number
  returnType: string | null
  locale: 'en' | 'it'
  /** New: fine-grained review sub-state from tax_return_submissions.review_status */
  reviewStatus?: ReviewStatus | null
  /** New: submission id for the Confirm action */
  submissionId?: string | null
  /** Legacy fallback for pre-Slice-2 submissions */
  dataReceived?: boolean
  sentToAccountant?: boolean
  /** MMLLC/Corp financials flow (Slice 9): link to the generated P&L + BS review screen. */
  showFinancialsLink?: boolean
}

const editHref = '/portal/wizard?type=tax'

function EditButton({ cta }: { cta: string }) {
  return (
    <a
      href={editHref}
      className="shrink-0 flex items-center gap-1.5 self-center rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700"
    >
      <Pencil className="h-3.5 w-3.5" />
      {cta}
    </a>
  )
}

function ConfirmButton({
  submissionId,
  locale,
  onConfirmed,
}: {
  submissionId: string
  locale: 'en' | 'it'
  onConfirmed: () => void
}) {
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle')
  const [errMsg, setErrMsg] = useState<string | null>(null)

  async function handleConfirm() {
    setState('loading')
    setErrMsg(null)
    try {
      const res = await fetch('/api/portal/tax-confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ submission_id: submissionId }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error((d as { error?: string }).error || (locale === 'it' ? 'Errore — riprova.' : 'Error — please try again.'))
      }
      onConfirmed()
    } catch (err) {
      setErrMsg(err instanceof Error && err.message ? err.message : (locale === 'it' ? 'Errore — riprova.' : 'Error — please try again.'))
      setState('idle')
    }
  }

  const label = locale === 'it' ? 'Conferma' : 'Confirm'

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={handleConfirm}
        disabled={state === 'loading'}
        className="shrink-0 flex items-center gap-1.5 self-center rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {state === 'loading' ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <CheckCircle className="h-3.5 w-3.5" />
        )}
        {label}
      </button>
      {errMsg && <p className="text-xs text-red-600">{errMsg}</p>}
    </div>
  )
}

export function TaxBanner({
  taxYear,
  returnType,
  locale,
  reviewStatus,
  submissionId,
  dataReceived = false,
  sentToAccountant = false,
  showFinancialsLink = false,
}: TaxBannerProps) {
  const router = useRouter()
  const returnLabel = returnType || 'Tax Return'

  // MMLLC/Corp: after submission the generated P&L + Balance Sheet live on
  // their own review screen (Slice 9) — surface the path from the banner.
  const financialsLink = showFinancialsLink ? (
    <a href="/portal/tax-financials" className="mt-2 inline-block text-xs font-semibold text-blue-700 underline hover:text-blue-900">
      {locale === 'it' ? 'Controlla e conferma il tuo Conto Economico e Stato Patrimoniale →' : 'Check and confirm your Profit & Loss and Balance Sheet →'}
    </a>
  ) : null

  // ─── New review-status states ───
  if (reviewStatus !== undefined && reviewStatus !== null) {
    switch (reviewStatus) {
      case 'submitted':
      case 'resubmitted': {
        const title = locale === 'it'
          ? `Dati fiscali inviati — in revisione (${taxYear})`
          : `Tax data submitted — under review (${taxYear})`
        const desc = locale === 'it'
          ? `I tuoi dati per la ${returnLabel} ${taxYear} sono stati inviati. Puoi ancora modificarli prima che iniziamo la revisione.`
          : `Your data for ${returnLabel} ${taxYear} has been submitted. You can still edit before we begin review.`
        const cta = locale === 'it' ? 'Modifica' : 'Edit'
        return (
          <div className="block w-full rounded-xl border-2 border-blue-300 bg-blue-50 px-5 py-4 mb-6">
            <div className="flex items-start gap-4">
              <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-100 border border-blue-300">
                <CheckCircle className="h-5 w-5 text-blue-600" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-blue-900 text-sm sm:text-base">{title}</p>
                <p className="text-blue-700 text-xs sm:text-sm mt-1">{desc}</p>
                {financialsLink}
              </div>
              <EditButton cta={cta} />
            </div>
          </div>
        )
      }

      case 'under_review': {
        const title = locale === 'it'
          ? `In revisione (${taxYear})`
          : `Under review (${taxYear})`
        const desc = locale === 'it'
          ? `Il nostro team sta esaminando i tuoi dati per la ${returnLabel} ${taxYear}. Ti avviseremo quando sarà pronto.`
          : `Our team is reviewing your ${returnLabel} ${taxYear} data. We'll notify you when we're done.`
        return (
          <div className="block w-full rounded-xl border-2 border-blue-300 bg-blue-50 px-5 py-4 mb-6">
            <div className="flex items-start gap-4">
              <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-100 border border-blue-300">
                <Clock className="h-5 w-5 text-blue-600" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-blue-900 text-sm sm:text-base">{title}</p>
                <p className="text-blue-700 text-xs sm:text-sm mt-1">{desc}</p>
              </div>
            </div>
          </div>
        )
      }

      case 'revision_requested': {
        const title = locale === 'it'
          ? `Modifiche richieste — ${returnLabel} ${taxYear}`
          : `Changes requested — ${returnLabel} ${taxYear}`
        const desc = locale === 'it'
          ? `Il nostro team ha richiesto alcune modifiche. Controlla la chat del portale per i dettagli, poi aggiorna e reinvia i tuoi dati.`
          : `Our team has requested changes. Check the portal chat for details, then update and resubmit your data.`
        const cta = locale === 'it' ? 'Modifica e reinvia' : 'Edit & resubmit'
        return (
          <a
            href={editHref}
            className="block w-full rounded-xl border-2 border-amber-400 bg-amber-50 px-5 py-4 transition-all hover:bg-amber-100 hover:shadow-md mb-6"
          >
            <div className="flex items-start gap-4">
              <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-100 border border-amber-300">
                <AlertTriangle className="h-5 w-5 text-amber-600" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-amber-900 text-sm sm:text-base">{title}</p>
                <p className="text-amber-700 text-xs sm:text-sm mt-1">{desc}</p>
              </div>
              <div className="shrink-0 flex items-center gap-1.5 self-center rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700">
                <Pencil className="h-3.5 w-3.5" />
                {cta}
              </div>
            </div>
          </a>
        )
      }

      case 'approved': {
        const title = locale === 'it'
          ? `Revisionato ✓ — ${returnLabel} ${taxYear}`
          : `Reviewed ✓ — ${returnLabel} ${taxYear}`
        const desc = locale === 'it'
          ? `I tuoi dati sono stati revisionati dal nostro team. Clicca Conferma per finalizzare la tua dichiarazione.`
          : `Your data has been reviewed by our team. Click Confirm to finalize your return.`
        const editCta = locale === 'it' ? 'Modifica' : 'Edit'
        return (
          <div className="block w-full rounded-xl border-2 border-emerald-300 bg-emerald-50 px-5 py-4 mb-6">
            <div className="flex items-start gap-4">
              <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-100 border border-emerald-300">
                <CheckCircle className="h-5 w-5 text-emerald-600" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-emerald-900 text-sm sm:text-base">{title}</p>
                <p className="text-emerald-700 text-xs sm:text-sm mt-1">{desc}</p>
              </div>
              <div className="shrink-0 flex items-center gap-2 self-center">
                {submissionId && (
                  <ConfirmButton
                    submissionId={submissionId}
                    locale={locale}
                    onConfirmed={() => router.refresh()}
                  />
                )}
                <EditButton cta={editCta} />
              </div>
            </div>
          </div>
        )
      }

      case 'confirmed': {
        const title = locale === 'it'
          ? `Confermato — in elaborazione (${taxYear})`
          : `Confirmed — being processed (${taxYear})`
        const desc = locale === 'it'
          ? `Hai confermato i tuoi dati per la ${returnLabel} ${taxYear}. Il nostro team inizierà l'elaborazione a breve.`
          : `You've confirmed your ${returnLabel} ${taxYear} data. Our team will begin processing shortly.`
        return (
          <div className="block w-full rounded-xl border-2 border-blue-300 bg-blue-50 px-5 py-4 mb-6">
            <div className="flex items-start gap-4">
              <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-100 border border-blue-300">
                <CheckCircle className="h-5 w-5 text-blue-600" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-blue-900 text-sm sm:text-base">{title}</p>
                <p className="text-blue-700 text-xs sm:text-sm mt-1">{desc}</p>
              </div>
            </div>
          </div>
        )
      }

      case 'reopened': {
        const title = locale === 'it'
          ? `Riaperto — rivedi e reinvia (${taxYear})`
          : `Reopened — please review and resubmit (${taxYear})`
        const desc = locale === 'it'
          ? `Il tuo invio è stato riaperto dal nostro team. Rivedi i tuoi dati e reinviali quando sei pronto.`
          : `Your submission has been reopened by our team. Review your data and resubmit when ready.`
        const cta = locale === 'it' ? 'Rivedi e reinvia' : 'Review & resubmit'
        return (
          <a
            href={editHref}
            className="block w-full rounded-xl border-2 border-amber-400 bg-amber-50 px-5 py-4 transition-all hover:bg-amber-100 hover:shadow-md mb-6"
          >
            <div className="flex items-start gap-4">
              <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-100 border border-amber-300">
                <AlertTriangle className="h-5 w-5 text-amber-600" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-amber-900 text-sm sm:text-base">{title}</p>
                <p className="text-amber-700 text-xs sm:text-sm mt-1">{desc}</p>
              </div>
              <div className="shrink-0 flex items-center gap-1.5 self-center rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700">
                <Pencil className="h-3.5 w-3.5" />
                {cta}
              </div>
            </div>
          </a>
        )
      }
    }
  }

  // ─── Legacy fallback (pre-Slice-2 submissions: no review_status) ───

  if (sentToAccountant) {
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
        href={editHref}
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
      href={editHref}
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
