'use client'

import Link from 'next/link'
import { AlertTriangle, Download } from 'lucide-react'
import { interpolateString } from '@/lib/template-interpolation'
import { deliveryReasonKey } from '@/lib/portal/resend-webhook'

/**
 * Shown on an invoice whose LAST email did not reach the customer (Resend reported a bounce, a block or a failure).
 * The invoice still says Sent (the client did send it), so without this the client would believe the customer has it.
 */
export function InvoiceDeliveryBanner({ t, problem, customerId, onDownload }: {
  t: (key: string) => string
  problem: { detail: string | null; to: string | null }
  customerId: string | null
  onDownload: () => void
}) {
  return (
    <div className="rounded-xl border border-red-200 bg-red-50 p-4 space-y-2" role="alert" data-testid="invoice-delivery-banner">
      <div className="flex items-start gap-3">
        <AlertTriangle className="h-5 w-5 text-red-600 mt-0.5 shrink-0" />
        <div className="space-y-1 text-sm text-red-900">
          <p className="font-semibold">{t('invDelivery.title')}</p>
          <p>{interpolateString(t('invDelivery.body'), { email: problem.to ?? '' })} {t(`invDelivery.reason.${deliveryReasonKey(problem.detail)}`)}</p>
          <p>{t('invDelivery.what')}</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 pl-8">
        <button onClick={onDownload} className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-red-300 rounded-lg bg-white text-red-800 hover:bg-red-100">
          <Download className="h-4 w-4" /> {t('invDelivery.download')}
        </button>
        {customerId && (
          <Link href={`/portal/customers/${customerId}`} className="px-3 py-1.5 text-sm border border-red-300 rounded-lg bg-white text-red-800 hover:bg-red-100">
            {t('invDelivery.editCustomer')}
          </Link>
        )}
      </div>
    </div>
  )
}
