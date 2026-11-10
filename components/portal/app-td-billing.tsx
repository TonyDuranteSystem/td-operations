'use client'

// TD Billing inside the CLIENT iPhone app (dev job 056a70d0, Step 3c; docs/systems/client-app.md): the invoices Tony Durante LLC sent,
// the totals, and a Pay button on the ones still open. Paying is the portal's own Pay Invoice pop-up (TdPayModal), unchanged.
// Drawn only inside the app. When Antonio's Pay switch is off (`client_app_pay_enabled`) the rows stay but nothing can be tapped to pay.
import { useState } from 'react'
import { format, parseISO } from 'date-fns'
import { FileText } from 'lucide-react'
import { useLocale } from '@/lib/portal/use-locale'
import { billingRowAmount, billingRowState, type BillingExpense, type BillingRowKind } from '@/lib/portal-app/invoices'
import { TdPayModal } from './td-pay-modal'

const TAG_STYLE: Record<BillingRowKind, string> = {
  due: 'bg-amber-100 text-amber-800',
  overdue: 'bg-red-100 text-red-800',
  paid: 'bg-green-100 text-green-800',
  credit: 'bg-emerald-100 text-emerald-800',
  cancelled: 'bg-zinc-100 text-zinc-600',
}

// "Nov 20" in the current year, "Nov 20, 2025" otherwise (a bare day is ambiguous in an old invoice).
function shortDate(d: string): string {
  try {
    const date = parseISO(d)
    return format(date, date.getFullYear() === new Date().getFullYear() ? 'MMM d' : 'MMM d, yyyy')
  } catch {
    return d
  }
}

function money(currency: string, n: number): string {
  return `${currency === 'EUR' ? '€' : '$'}${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2 })}`
}

export function AppTdBilling({
  rows,
  totals,
  payEnabled,
}: {
  rows: BillingExpense[]
  totals: { pending: string; paid: string; total: string }
  payEnabled: boolean
}) {
  const { t } = useLocale()
  const [paying, setPaying] = useState<BillingExpense | null>(null)

  const tagText = (kind: BillingRowKind, date: string | null): string => {
    const d = date ? shortDate(date) : null
    switch (kind) {
      case 'due': return d ? t('app.billing.due').replace('{date}', d) : t('app.billing.dueNoDate')
      case 'overdue': return d ? t('app.billing.overdue').replace('{date}', d) : t('app.billing.overdueNoDate')
      case 'paid': return d ? t('app.billing.paidOn').replace('{date}', d) : t('app.billing.paidNoDate')
      case 'credit': return t('app.billing.credit')
      case 'cancelled': return t('app.billing.cancelled')
    }
  }

  return (
    <div className="space-y-4" data-testid="app-td-billing">
      <p className="px-1 text-sm leading-snug text-zinc-600">{t('app.billing.subtitle')}</p>

      <section aria-label={t('app.billing.total')} className="flex gap-2.5 rounded-[18px] border border-zinc-200 bg-white p-4" data-testid="app-billing-totals">
        {([
          ['app.billing.pending', totals.pending, 'text-amber-700'],
          ['app.billing.paid', totals.paid, 'text-green-700'],
          ['app.billing.total', totals.total, 'text-zinc-900'],
        ] as const).map(([key, value, color]) => (
          <div key={key} className="min-w-0 flex-1">
            <div className="text-[11.5px] font-bold uppercase tracking-wide text-zinc-600">{t(key)}</div>
            {/* one currency per line: dollars and euros are never added together and a long pair must not be cut off */}
            <div className={`mt-1 text-xl font-bold leading-tight ${color}`}>
              {value.split(' · ').map(part => <div key={part}>{part}</div>)}
            </div>
          </div>
        ))}
      </section>

      <section aria-label={t('app.billing.allInvoices')} className="rounded-[18px] border border-zinc-200 bg-white py-1.5">
        <h2 className="px-4 pb-1 pt-3 text-[13px] font-bold uppercase tracking-wide text-zinc-600">{t('app.billing.allInvoices')}</h2>
        {rows.length === 0 ? (
          <div className="px-4 py-8 text-center" data-testid="app-billing-empty">
            <FileText className="mx-auto mb-2 h-10 w-10 text-zinc-300" aria-hidden="true" />
            <p className="text-sm text-zinc-600">{t('app.billing.empty')}</p>
          </div>
        ) : (
          rows.map((row, i) => {
            const state = billingRowState(row)
            const number = row.invoice_number || row.internal_ref || ''
            const amount = billingRowAmount(row)
            const payable = payEnabled && state.canPay
            const content = (
              <>
                <span className="min-w-0 flex-1">
                  <span className="block whitespace-nowrap text-base font-semibold leading-tight text-zinc-900">{number || '—'}</span>
                  <span className="mt-0.5 block truncate text-[13px] text-zinc-600">{row.description || row.vendor_name}</span>
                </span>
                <span className="text-right">
                  <span className={`block text-base font-bold ${state.kind === 'credit' ? 'text-emerald-700' : 'text-zinc-900'}`}>
                    {state.kind === 'credit' ? '−' : ''}{money(row.currency, amount)}
                  </span>
                  <span className={`mt-0.5 inline-block rounded-full px-2.5 py-0.5 text-[11.5px] font-bold ${TAG_STYLE[state.kind]}`}>{tagText(state.kind, state.date)}</span>
                </span>
                {payable && (
                  <span className="rounded-full bg-zinc-900 px-4 py-2 text-[15px] font-semibold leading-tight text-white" aria-hidden="true">{t('app.billing.pay')}</span>
                )}
              </>
            )
            return (
              <div key={row.id} data-testid={`app-billing-row-${number}`}>
                {i > 0 && <div className="ml-4 h-px bg-zinc-200" />}
                {payable ? (
                  <button
                    type="button"
                    onClick={() => setPaying(row)}
                    aria-label={t('app.billing.payInvoice').replace('{number}', () => number)}
                    className="flex min-h-[64px] w-full items-center gap-3 px-4 py-3 text-left"
                  >
                    {content}
                  </button>
                ) : (
                  <div className="flex min-h-[64px] items-center gap-3 px-4 py-3">{content}</div>
                )}
              </div>
            )
          })
        )}
      </section>

      {paying && paying.td_payment_id && (
        <TdPayModal
          paymentId={paying.td_payment_id}
          invoiceNumber={paying.invoice_number || paying.internal_ref || 'Invoice'}
          amount={billingRowAmount(paying)}
          currency={paying.currency}
          onClose={() => setPaying(null)}
        />
      )}
    </div>
  )
}
