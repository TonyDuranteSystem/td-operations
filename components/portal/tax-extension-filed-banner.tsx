'use client'

import { CheckCircle, Clock } from 'lucide-react'

export interface TaxExtensionFiledBannerProps {
  firstName: string | null
  confirmationId: string | null
  deadlineDisplay: string | null
  locale: 'en' | 'it'
}

/**
 * Shown at the top of the client's portal home when their Tax Return SD
 * is on_hold (typically because their extension was filed and we're
 * waiting for them to pay the 2nd installment before resuming).
 *
 * Handles nulls gracefully:
 *   - missing firstName → "Dear Client"
 *   - missing confirmationId → omit the "Confirmation ID" line
 *   - missing deadlineDisplay → omit the "Extension deadline" line
 *     (resolveExtensionDeadline + formatDeadlineForDisplay usually
 *     provide this computed from tax_year + return_type even when
 *     tax_returns.extension_deadline is null in the DB)
 */
export function TaxExtensionFiledBanner({
  firstName,
  confirmationId,
  deadlineDisplay,
  locale,
}: TaxExtensionFiledBannerProps) {
  const t = locale === 'it' ? IT : EN
  const greeting = firstName ? `${t.greeting} ${firstName},` : t.greetingFallback

  return (
    <div
      className="flex items-start gap-3 bg-emerald-50 border border-emerald-200 rounded-xl p-5"
      data-testid="tax-extension-filed-banner"
    >
      <CheckCircle className="h-5 w-5 text-emerald-600 shrink-0 mt-0.5" />
      <div className="space-y-1.5">
        <p className="font-semibold text-emerald-900">{greeting}</p>
        <p className="text-sm text-emerald-800 leading-relaxed">
          {t.extensionFiled}
        </p>
        <div className="flex flex-col sm:flex-row sm:items-center sm:gap-4 gap-1 text-sm">
          {confirmationId && (
            <span className="text-emerald-800">
              <span className="text-emerald-700 font-medium">{t.confirmationId}:</span>{' '}
              <span className="font-mono">{confirmationId}</span>
            </span>
          )}
          {deadlineDisplay && (
            <span className="text-emerald-800 inline-flex items-center gap-1">
              <Clock className="h-3.5 w-3.5 text-emerald-600" />
              <span className="text-emerald-700 font-medium">{t.extensionDeadline}:</span>{' '}
              <span>{deadlineDisplay}</span>
            </span>
          )}
        </div>
        <p className="text-sm text-emerald-700 mt-1">{t.resumeLine}</p>
      </div>
    </div>
  )
}

const EN = {
  greeting: 'Dear',
  greetingFallback: 'Dear Client,',
  extensionFiled: 'Your tax extension has been filed.',
  confirmationId: 'Confirmation ID',
  extensionDeadline: 'Extension deadline',
  resumeLine: "We'll resume processing your return soon (typically June–July). No action needed from you right now.",
}

const IT = {
  greeting: 'Caro',
  greetingFallback: 'Caro Cliente,',
  extensionFiled: 'La proroga della tua dichiarazione dei redditi è stata depositata.',
  confirmationId: 'ID di conferma',
  extensionDeadline: 'Scadenza della proroga',
  resumeLine: 'Riprenderemo a elaborare la tua dichiarazione a breve (tipicamente tra giugno e luglio). Al momento non serve nessuna azione da parte tua.',
}
