'use client'

import { cn } from '@/lib/utils'
import { format, parseISO } from 'date-fns'
import { X, Building2, FileText } from 'lucide-react'
import { useLocale } from '@/lib/portal/use-locale'
import { FastTooltip } from '@/components/ui/fast-tooltip'
import type { Vendor } from '@/app/portal/invoices/vendor-actions'
import type { Expense } from './expense-list'

const STATUS_COLORS: Record<string, string> = {
  Pending: 'bg-amber-100 text-amber-700',
  Paid: 'bg-emerald-100 text-emerald-700',
  Overdue: 'bg-red-100 text-red-700',
  Cancelled: 'bg-zinc-100 text-zinc-500',
}

function fmtDate(d: string | null): string {
  if (!d) return '—'
  try { return format(parseISO(d), 'MMM d, yy') } catch { return d }
}

function fmtAmount(currency: string, amount: number): string {
  const symbol = currency === 'EUR' ? '€' : '$'
  return `${symbol}${amount.toLocaleString('en-US', { minimumFractionDigits: 2 })}`
}

export function VendorStatementModal({
  vendor,
  expenses,
  onClose,
}: {
  vendor: Vendor
  expenses: Expense[]
  onClose: () => void
}) {
  const { t } = useLocale()

  const transactions = expenses
    .filter(e => e.vendor_id === vendor.id)
    .sort((a, b) => (b.issue_date ?? '').localeCompare(a.issue_date ?? ''))

  const totalSpent = transactions.reduce((s, e) => s + Number(e.total), 0)
  const paid = transactions.filter(e => e.status === 'Paid').reduce((s, e) => s + Number(e.total), 0)
  const pending = transactions.filter(e => e.status !== 'Paid' && e.status !== 'Cancelled').reduce((s, e) => s + Number(e.total), 0)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-xl max-w-2xl w-full max-h-[85vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 p-5 border-b">
          <div className="flex items-center gap-2 min-w-0">
            <div className="h-8 w-8 rounded-full bg-blue-50 flex items-center justify-center shrink-0">
              <Building2 className="h-4 w-4 text-blue-600" />
            </div>
            <div className="min-w-0">
              <h3 className="text-base font-semibold text-zinc-900 truncate">{vendor.name}</h3>
              <p className="text-xs text-zinc-500">
                {t('vendorStatement.transactionCount').replace('{count}', String(transactions.length))}
              </p>
            </div>
          </div>
          <FastTooltip label={t('common.cancel')}>
            <button
              onClick={onClose}
              className="text-zinc-400 hover:text-zinc-600 p-1 -m-1 shrink-0"
              aria-label={t('common.cancel')}
            >
              <X className="h-5 w-5" />
            </button>
          </FastTooltip>
        </div>

        <div className="p-5 pb-0 grid grid-cols-3 gap-3">
          <div className="bg-zinc-50 rounded-lg p-3">
            <p className="text-[10px] text-zinc-500 uppercase tracking-wide">{t('vendorStatement.totalSpent')}</p>
            <p className="text-sm sm:text-base font-semibold text-zinc-900 mt-0.5">{fmtAmount('USD', totalSpent)}</p>
          </div>
          <div className="bg-zinc-50 rounded-lg p-3">
            <p className="text-[10px] text-zinc-500 uppercase tracking-wide">{t('vendorStatement.paid')}</p>
            <p className="text-sm sm:text-base font-semibold text-emerald-600 mt-0.5">{fmtAmount('USD', paid)}</p>
          </div>
          <div className="bg-zinc-50 rounded-lg p-3">
            <p className="text-[10px] text-zinc-500 uppercase tracking-wide">{t('vendorStatement.pending')}</p>
            <p className="text-sm sm:text-base font-semibold text-amber-600 mt-0.5">{fmtAmount('USD', pending)}</p>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {transactions.length === 0 ? (
            <div className="py-8 text-center">
              <FileText className="h-10 w-10 text-zinc-300 mx-auto mb-2" />
              <p className="text-sm text-zinc-500">{t('vendorStatement.noTransactions')}</p>
            </div>
          ) : (
            <div className="border rounded-lg overflow-hidden">
              <div className="hidden sm:grid sm:grid-cols-[1fr,100px,90px] gap-3 px-3 py-2 border-b bg-zinc-50 text-[10px] font-medium text-zinc-500 uppercase">
                <span>{t('expenseList.invoiceNumberShort')}</span>
                <span>{t('expenseList.date')}</span>
                <span className="text-right">{t('expenseList.amount')}</span>
              </div>
              {transactions.map(tx => (
                <div
                  key={tx.id}
                  className="grid grid-cols-1 sm:grid-cols-[1fr,100px,90px] gap-1 sm:gap-3 px-3 py-2.5 border-b last:border-b-0 items-center text-sm"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="truncate">{tx.invoice_number || tx.internal_ref || '—'}</span>
                    <span className={cn('shrink-0 text-[10px] px-1.5 py-0.5 rounded-full', STATUS_COLORS[tx.status] ?? 'bg-zinc-100')}>
                      {tx.status}
                    </span>
                  </div>
                  <span className="text-xs text-zinc-500">{fmtDate(tx.issue_date)}</span>
                  <span className="text-right font-medium">{fmtAmount(tx.currency, Number(tx.total))}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
