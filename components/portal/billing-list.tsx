'use client'

import { cn } from '@/lib/utils'
import { format, parseISO } from 'date-fns'
import Link from 'next/link'
import { FileText, Download, CheckCircle2, Clock, AlertCircle, CreditCard } from 'lucide-react'
import { t, type Locale } from '@/lib/portal/i18n'

interface BillingInvoice {
  id: string
  invoice_number: string | null
  invoice_status: string | null
  description: string | null
  total: number | string | null
  amount: number | string | null
  amount_currency: string | null
  issue_date: string | null
  due_date: string | null
  paid_date: string | null
  sent_at: string | null
  message: string | null
  payment_items: Array<{
    description: string
    quantity: number
    unit_price: number
    amount: number
  }> | null
}

interface Props {
  invoices: BillingInvoice[]
  locale: Locale
}

const STATUS_STYLES: Record<string, { bg: string; text: string; icon: typeof CheckCircle2 }> = {
  Paid: { bg: 'bg-emerald-50 border-emerald-200', text: 'text-emerald-700', icon: CheckCircle2 },
  Sent: { bg: 'bg-blue-50 border-blue-200', text: 'text-blue-700', icon: Clock },
  Overdue: { bg: 'bg-red-50 border-red-200', text: 'text-red-700', icon: AlertCircle },
  Draft: { bg: 'bg-zinc-50 border-zinc-200', text: 'text-zinc-500', icon: FileText },
  Voided: { bg: 'bg-zinc-50 border-zinc-200', text: 'text-zinc-400 line-through', icon: FileText },
  Credit: { bg: 'bg-purple-50 border-purple-200', text: 'text-purple-700', icon: FileText },
}

function formatCurrency(amount: number | string | null, currency?: string | null): string {
  if (amount == null) return '—'
  const num = typeof amount === 'string' ? parseFloat(amount) : amount
  if (isNaN(num)) return '—'
  const c = currency === 'EUR' ? '€' : '$'
  return `${c}${Math.abs(num).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function formatDate(d: string | null): string {
  if (!d) return '—'
  try { return format(parseISO(d), 'MMM d, yyyy') } catch { return d }
}

export function BillingList({ invoices, locale }: Props) {
  if (invoices.length === 0) {
    return (
      <div className="bg-white rounded-xl border shadow-sm p-12 text-center">
        <FileText className="h-12 w-12 text-zinc-300 mx-auto mb-3" />
        <h3 className="text-lg font-medium text-zinc-900 mb-1">{t('billing.noInvoices', locale)}</h3>
        <p className="text-sm text-zinc-500">{t('billing.noInvoicesDesc', locale)}</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {invoices.map(inv => {
        const status = inv.invoice_status ?? 'Draft'
        const style = STATUS_STYLES[status] ?? STATUS_STYLES.Draft
        const StatusIcon = style.icon
        const total = Number(inv.total ?? inv.amount ?? 0)
        const isCredit = status === 'Credit'

        return (
          <div key={inv.id} className={cn('bg-white rounded-xl border shadow-sm overflow-hidden', style.bg)}>
            {/* Header row */}
            <div className="flex items-center gap-3 px-4 py-3 sm:px-5">
              <StatusIcon className={cn('h-5 w-5 shrink-0', style.text)} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm font-medium text-zinc-900">
                    {inv.invoice_number ?? '—'}
                  </span>
                  <span className={cn('text-xs font-medium px-2 py-0.5 rounded-full', style.text, status === 'Paid' ? 'bg-emerald-100' : status === 'Overdue' ? 'bg-red-100' : status === 'Credit' ? 'bg-purple-100' : 'bg-zinc-100')}>
                    {t(`billing.status.${status.toLowerCase()}`, locale)}
                  </span>
                </div>
                <p className="text-xs text-zinc-500 mt-0.5 truncate">{inv.description || '—'}</p>
              </div>
              <div className="text-right shrink-0">
                <p className={cn('text-lg font-semibold', isCredit ? 'text-purple-700' : style.text)}>
                  {isCredit ? '-' : ''}{formatCurrency(total, inv.amount_currency)}
                </p>
                <p className="text-xs text-zinc-400 mt-0.5">
                  {inv.issue_date ? formatDate(inv.issue_date) : ''}
                </p>
              </div>
            </div>

            {/* Details row */}
            <div className="px-4 pb-3 sm:px-5 flex items-center gap-4 text-xs text-zinc-500">
              {inv.due_date && status !== 'Paid' && (
                <span>
                  {t('billing.dueDate', locale)}: <strong className={status === 'Overdue' ? 'text-red-600' : ''}>{formatDate(inv.due_date)}</strong>
                </span>
              )}
              {inv.paid_date && (
                <span>
                  {t('billing.paidOn', locale)}: <strong className="text-emerald-600">{formatDate(inv.paid_date)}</strong>
                </span>
              )}

              <div className="ml-auto flex items-center gap-2">
                {/* Pay link for unpaid invoices */}
                {(status === 'Sent' || status === 'Overdue') && (
                  <Link
                    href={`/portal/invoices/${inv.id}`}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-white bg-blue-600 hover:bg-blue-700 transition-colors text-xs font-medium"
                  >
                    <CreditCard className="h-3.5 w-3.5" />
                    {t('pay.payNow', locale)}
                  </Link>
                )}
                {/* Download PDF */}
                <a
                  href={`/api/invoices/${inv.id}/pdf`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-blue-600 hover:bg-blue-50 transition-colors"
                >
                  <Download className="h-3.5 w-3.5" />
                  PDF
                </a>
              </div>
            </div>

            {/* Line items (expandable) */}
            {inv.payment_items && inv.payment_items.length > 0 && (
              <details className="border-t">
                <summary className="px-4 sm:px-5 py-2 text-xs text-zinc-500 cursor-pointer hover:bg-zinc-50/50">
                  {inv.payment_items.length} {t('billing.lineItems', locale)}
                </summary>
                <div className="px-4 sm:px-5 pb-3">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-zinc-400">
                        <th className="text-left pb-1 font-medium">{t('billing.item', locale)}</th>
                        <th className="text-right pb-1 font-medium w-16">Qty</th>
                        <th className="text-right pb-1 font-medium w-20">{t('billing.price', locale)}</th>
                        <th className="text-right pb-1 font-medium w-24">{t('billing.amount', locale)}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {inv.payment_items.map((item, i) => (
                        <tr key={i} className="border-t border-zinc-100">
                          <td className="py-1.5 text-zinc-700">{item.description}</td>
                          <td className="py-1.5 text-right text-zinc-500">{item.quantity}</td>
                          <td className="py-1.5 text-right text-zinc-500">{formatCurrency(item.unit_price, inv.amount_currency)}</td>
                          <td className="py-1.5 text-right font-medium text-zinc-700">{formatCurrency(item.amount, inv.amount_currency)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            )}
          </div>
        )
      })}
    </div>
  )
}
