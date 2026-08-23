'use client'

import { CheckCircle, Clock } from 'lucide-react'
import { useLocale } from '@/lib/portal/use-locale'

export interface TaxExtensionFiledBannerProps {
  firstName: string | null
  confirmationId: string | null
  deadlineDisplay: string | null
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
}: TaxExtensionFiledBannerProps) {
  const { t } = useLocale()
  const greeting = firstName ? `${t('taxExtensionBanner.greeting')} ${firstName},` : t('taxExtensionBanner.greetingFallback')

  return (
    <div
      className="flex items-start gap-3 bg-emerald-50 border border-emerald-200 rounded-xl p-5"
      data-testid="tax-extension-filed-banner"
    >
      <CheckCircle className="h-5 w-5 text-emerald-600 shrink-0 mt-0.5" />
      <div className="space-y-1.5">
        <p className="font-semibold text-emerald-900">{greeting}</p>
        <p className="text-sm text-emerald-800 leading-relaxed">
          {t('taxExtensionBanner.extensionFiled')}
        </p>
        <div className="flex flex-col sm:flex-row sm:items-center sm:gap-4 gap-1 text-sm">
          {confirmationId && (
            <span className="text-emerald-800">
              <span className="text-emerald-700 font-medium">{t('taxExtensionBanner.confirmationId')}:</span>{' '}
              <span className="font-mono">{confirmationId}</span>
            </span>
          )}
          {deadlineDisplay && (
            <span className="text-emerald-800 inline-flex items-center gap-1">
              <Clock className="h-3.5 w-3.5 text-emerald-600" />
              <span className="text-emerald-700 font-medium">{t('taxExtensionBanner.extensionDeadline')}:</span>{' '}
              <span>{deadlineDisplay}</span>
            </span>
          )}
        </div>
        <p className="text-sm text-emerald-700 mt-1">{t('taxExtensionBanner.resumeLine')}</p>
      </div>
    </div>
  )
}
