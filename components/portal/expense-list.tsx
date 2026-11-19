'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { cn } from '@/lib/utils'
import { format, parseISO } from 'date-fns'
import { Search, FileText, Building2, Upload, PenLine, Download, Loader2, CreditCard, Banknote, X } from 'lucide-react'
import { toast } from 'sonner'
import { TdPayModal } from './td-pay-modal'
import { markExpensePaid } from '@/app/portal/invoices/expense-actions'
import { useLocale } from '@/lib/portal/use-locale'
import { FastTooltip } from '@/components/ui/fast-tooltip'
import { AppStatusPill } from '@/components/portal/app-status-pill'
import { expenseStatusTone, groupByMonth } from '@/lib/portal-app/invoices'

export interface Expense {
  id: string
  vendor_id: string | null
  vendor_name: string
  invoice_number: string | null
  internal_ref: string | null
  description: string | null
  currency: string
  total: number
  amount_due?: number | null
  amount_paid?: number | null
  issue_date: string | null
  due_date: string | null
  paid_date: string | null
  status: string
  source: string
  category: string | null
  attachment_url: string | null
  attachment_name: string | null
  td_payment_id: string | null
  // Mixed-list scope badge: "Personal" or company name. Set by the page when
  // both contact-scoped and account-scoped expenses are merged into one list
  // for active clients with a company. Undefined for single-scope lists.
  scope_label?: string | null
}

const STATUS_COLORS: Record<string, string> = {
  Pending: 'bg-amber-100 text-amber-700',
  Paid: 'bg-emerald-100 text-emerald-700',
  Overdue: 'bg-red-100 text-red-700',
  Cancelled: 'bg-zinc-100 text-zinc-500',
}

const SOURCE_CONFIG: Record<string, { icon: typeof Building2; label: string; className: string }> = {
  td_invoice: { icon: Building2, label: 'TD LLC', className: 'bg-blue-50 text-blue-700 border-blue-200' },
  upload: { icon: Upload, label: 'Uploaded', className: 'bg-purple-50 text-purple-700 border-purple-200' },
  manual: { icon: PenLine, label: 'Manual', className: 'bg-zinc-50 text-zinc-600 border-zinc-200' },
}

const STATUS_TABS = ['All', 'Pending', 'Paid', 'Overdue']

const STATUS_TAB_LABEL_KEYS: Record<string, string> = {
  All: 'expenseList.all',
  Pending: 'expenseList.pending',
  Paid: 'expenseList.paid',
  Overdue: 'expenseList.overdue',
}

function fmtDate(d: string | null): string {
  if (!d) return '—'
  try { return format(parseISO(d), 'MMM d, yy') } catch { return d }
}

export function ExpenseList({
  expenses,
  initialFilter = 'All',
  hidePay = false,
  compact = false,
}: {
  expenses: Expense[]
  initialFilter?: 'All' | 'Pending' | 'Paid' | 'Overdue'
  /** The client iPhone app's Pay switch is off: the Pay button is not offered (the website never sets this). */
  hidePay?: boolean
  /** The client iPhone app's look (gray chips, compact rows grouped by month); the website never sets this. */
  compact?: boolean
}) {
  const { t } = useLocale()
  const router = useRouter()
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>(initialFilter)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [payingExpense, setPayingExpense] = useState<Expense | null>(null)
  const [markingPaidId, setMarkingPaidId] = useState<string | null>(null)
  const [confirmingPaidExpense, setConfirmingPaidExpense] = useState<Expense | null>(null)

  const handleMarkPaid = async (exp: Expense) => {
    setConfirmingPaidExpense(null)
    setMarkingPaidId(exp.id)
    try {
      const res = await markExpensePaid(exp.id)
      if (!res.success) throw new Error(res.error)
      toast.success(t('expenseList.markedPaid'))
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : t('expenseList.markPaidFailed'))
    } finally {
      setMarkingPaidId(null)
    }
  }

  const handleDownloadPdf = async (exp: Expense) => {
    if (!exp.td_payment_id) return
    setDownloadingId(exp.id)
    try {
      const res = await fetch(`/api/portal/payments/${exp.td_payment_id}/pdf`)
      if (!res.ok) throw new Error('Failed to generate PDF')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${exp.invoice_number ?? 'invoice'}.pdf`
      a.click()
      URL.revokeObjectURL(url)
      toast.success(t('expenseList.pdfDownloaded'))
    } catch {
      toast.error(t('expenseList.pdfDownloadFailed'))
    } finally {
      setDownloadingId(null)
    }
  }

  const filtered = expenses.filter(exp => {
    if (statusFilter !== 'All' && exp.status !== statusFilter) return false
    if (search) {
      const q = search.toLowerCase()
      return (exp.vendor_name?.toLowerCase().includes(q)) ||
        (exp.invoice_number?.toLowerCase().includes(q)) ||
        (exp.description?.toLowerCase().includes(q))
    }
    return true
  })

  return (
    <div className="space-y-4">
      {!compact && (<>
      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={t('expenseList.searchPlaceholder')}
            className="w-full pl-9 pr-3 py-2.5 text-sm border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div className="flex gap-1.5">
          {STATUS_TABS.map(tab => (
            <button
              key={tab}
              onClick={() => setStatusFilter(tab)}
              className={cn(
                'px-3 py-2 text-xs rounded-lg border transition-colors',
                statusFilter === tab ? 'bg-blue-50 border-blue-200 text-blue-700' : 'bg-white text-zinc-600 hover:bg-zinc-50'
              )}
            >
              {STATUS_TAB_LABEL_KEYS[tab] ? t(STATUS_TAB_LABEL_KEYS[tab]) : tab}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
        <div className="hidden md:grid md:grid-cols-[1fr,120px,100px,90px,80px,80px,80px] gap-3 px-4 py-3 border-b bg-zinc-50 text-xs font-medium text-zinc-500 uppercase">
          <span>{t('expenseList.vendor')}</span>
          <span>{t('expenseList.invoiceNumberShort')}</span>
          <span className="text-right">{t('expenseList.amount')}</span>
          <span>{t('expenseList.date')}</span>
          <span>{t('expenseList.status')}</span>
          <span>{t('expenseList.source')}</span>
          <span></span>
        </div>
        {filtered.length === 0 ? (
          <div className="p-8 text-center">
            <FileText className="h-10 w-10 text-zinc-300 mx-auto mb-2" />
            <p className="text-sm text-zinc-500">
              {t('expenseList.noExpensesFound')}
            </p>
          </div>
        ) : (
          filtered.map(exp => {
            const src = SOURCE_CONFIG[exp.source] || SOURCE_CONFIG.manual
            const SourceIcon = src.icon
            return (
              <div key={exp.id} className="grid grid-cols-1 md:grid-cols-[1fr,120px,100px,90px,80px,80px,80px] gap-1 md:gap-3 px-4 py-3 border-b last:border-b-0 items-center text-sm hover:bg-zinc-50/50 transition-colors">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-medium truncate">{exp.vendor_name}</span>
                  {exp.scope_label && (
                    <FastTooltip label={exp.scope_label} align="left">
                      <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-zinc-100 text-zinc-600 border border-zinc-200">
                        {exp.scope_label}
                      </span>
                    </FastTooltip>
                  )}
                  {exp.attachment_url && (
                    <a href={exp.attachment_url} target="_blank" rel="noopener noreferrer" className="shrink-0 text-zinc-400 hover:text-blue-600">
                      <FileText className="h-3.5 w-3.5" />
                    </a>
                  )}
                </div>
                <span className="text-zinc-600 text-xs truncate">{exp.invoice_number || exp.internal_ref || '—'}</span>
                <span className="text-right font-medium">
                  {Number(exp.total) < 0 ? (
                    // Credit note (negative total): a credit TO the client, not a $0 bill.
                    <span className="text-emerald-600">
                      {'\u2212'}{exp.currency === 'EUR' ? '\u20AC' : '$'}
                      {Math.abs(Number(exp.total)).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                    </span>
                  ) : (
                    <>
                      {exp.currency === 'EUR' ? '\u20AC' : '$'}
                      {Number(exp.amount_due ?? exp.total).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                      {exp.amount_due != null && exp.amount_due < exp.total && (
                        <span className="ml-1 text-[10px] font-normal text-zinc-400 line-through">
                          {exp.currency === 'EUR' ? '\u20AC' : '$'}{Number(exp.total).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                        </span>
                      )}
                    </>
                  )}
                </span>
                <span className="text-xs text-zinc-500">
                  {fmtDate(exp.issue_date)}
                </span>
                <span>
                  {Number(exp.total) < 0 ? (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">
                      {t('expenseList.credit')}
                    </span>
                  ) : (
                    <span className={cn('text-xs px-2 py-0.5 rounded-full', STATUS_COLORS[exp.status] ?? 'bg-zinc-100')}>
                      {exp.status}
                    </span>
                  )}
                </span>
                <span>
                  <span className={cn('inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border', src.className)}>
                    <SourceIcon className="h-3 w-3" />
                    {src.label}
                  </span>
                </span>
                <span className="flex items-center justify-center gap-1">
                  {!hidePay && exp.source === 'td_invoice' && exp.td_payment_id && (exp.status === 'Pending' || exp.status === 'Overdue') && (
                    <FastTooltip label={t('expenseList.pay')}>
                      <button
                        onClick={() => setPayingExpense(exp)}
                        className="p-1 rounded hover:bg-blue-50 text-blue-600 hover:text-blue-700"
                        aria-label={t('expenseList.pay')}
                      >
                        <CreditCard className="h-4 w-4" />
                      </button>
                    </FastTooltip>
                  )}
                  {exp.source !== 'td_invoice' && (exp.status === 'Pending' || exp.status === 'Overdue') && (
                    <FastTooltip label={t('expenseList.markPaid')}>
                      <button
                        onClick={() => setConfirmingPaidExpense(exp)}
                        disabled={markingPaidId === exp.id}
                        className="p-1 rounded hover:bg-emerald-50 text-emerald-600 hover:text-emerald-700 disabled:opacity-50"
                        aria-label={t('expenseList.markPaid')}
                      >
                        {markingPaidId === exp.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Banknote className="h-4 w-4" />}
                      </button>
                    </FastTooltip>
                  )}
                  {exp.td_payment_id ? (
                    <FastTooltip label={t('expenseList.downloadPdf')}>
                      <button
                        onClick={() => handleDownloadPdf(exp)}
                        disabled={downloadingId === exp.id}
                        className="p-1 rounded hover:bg-zinc-100 text-zinc-400 hover:text-blue-600 disabled:opacity-50"
                        aria-label={t('expenseList.downloadPdf')}
                      >
                        {downloadingId === exp.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                      </button>
                    </FastTooltip>
                  ) : exp.attachment_url ? (
                    <a href={exp.attachment_url} target="_blank" rel="noopener noreferrer" className="p-1 rounded hover:bg-zinc-100 text-zinc-400 hover:text-blue-600">
                      <Download className="h-4 w-4" />
                    </a>
                  ) : null}
                </span>
              </div>
            )
          })
        )}
      </div>
      </>)}

      {compact && (
        <div className="space-y-3" data-testid="app-expense-list">
          <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
            {STATUS_TABS.map(tab => (
              <button
                key={tab}
                type="button"
                onClick={() => setStatusFilter(tab)}
                className={cn(
                  'shrink-0 rounded-full border px-3.5 py-2 text-[13px] font-semibold',
                  statusFilter === tab ? 'border-zinc-800 bg-zinc-800 text-white' : 'border-zinc-200 bg-white text-zinc-700',
                )}
              >
                {STATUS_TAB_LABEL_KEYS[tab] ? t(STATUS_TAB_LABEL_KEYS[tab]) : tab}
              </button>
            ))}
          </div>
          <div className="relative">
            <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" aria-hidden="true" />
            <input
              type="search"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={t('expenseList.searchPlaceholder')}
              className="w-full rounded-[14px] border border-zinc-200 bg-white py-3 pl-10 pr-3 text-[15px] focus:outline-none focus:ring-2 focus:ring-zinc-400"
            />
          </div>
          {filtered.length === 0 ? (
            <div className="rounded-[18px] border border-zinc-200 bg-white p-6 text-center text-sm text-zinc-500">{t('expenseList.noExpensesFound')}</div>
          ) : (
            groupByMonth(filtered).map((group, gi) => (
              <div key={`${group.label}-${gi}`} className="space-y-2">
                {group.label && <p className="px-1 pt-1 text-xs font-bold text-zinc-500">{group.label}</p>}
                <div className="overflow-hidden rounded-[18px] border border-zinc-200 bg-white">
                  {group.rows.map((exp, i) => {
                    const credit = Number(exp.total) < 0
                    const symbol = exp.currency === 'EUR' ? '\u20AC' : '$'
                    const open = exp.status === 'Pending' || exp.status === 'Overdue'
                    const canPay = !hidePay && exp.source === 'td_invoice' && !!exp.td_payment_id && open
                    const canMarkPaid = exp.source !== 'td_invoice' && open
                    const canDownload = !!exp.td_payment_id || !!exp.attachment_url
                    return (
                      <div key={exp.id} data-testid="app-expense-row" className={cn('grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 px-4 py-3', i > 0 && 'border-t border-zinc-200')}>
                        <div className="min-w-0">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="truncate text-[15px] font-semibold text-zinc-900">{exp.vendor_name}</span>
                            {exp.scope_label && <span className="shrink-0 rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-600">{exp.scope_label}</span>}
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-zinc-500">
                            {exp.source === 'td_invoice' && <span className="rounded bg-zinc-200 px-1.5 py-px text-[10px] font-bold text-zinc-700">TD</span>}
                            {exp.source === 'upload' && <span className="rounded bg-zinc-100 px-1.5 py-px text-[10px] font-semibold text-zinc-600">{SOURCE_CONFIG.upload.label}</span>}
                            {exp.source === 'manual' && <span className="rounded bg-zinc-100 px-1.5 py-px text-[10px] font-semibold text-zinc-600">{SOURCE_CONFIG.manual.label}</span>}
                            <span>{exp.invoice_number || exp.internal_ref || '\u2014'} · {fmtDate(exp.issue_date)}</span>
                          </div>
                        </div>
                        <div className="text-right">
                          {credit ? (
                            <span className="text-[15px] font-bold tabular-nums text-emerald-700">{'\u2212'}{symbol}{Math.abs(Number(exp.total)).toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
                          ) : (
                            <>
                              <span className="text-[15px] font-bold tabular-nums text-zinc-900">{symbol}{Number(exp.amount_due ?? exp.total).toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
                              {exp.amount_due != null && exp.amount_due < exp.total && (
                                <span className="ml-1 text-[10px] text-zinc-400 line-through">{symbol}{Number(exp.total).toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
                              )}
                            </>
                          )}
                          <div className="mt-0.5">
                            {credit ? <AppStatusPill tone="ok">{t('expenseList.credit')}</AppStatusPill> : <AppStatusPill tone={expenseStatusTone(exp.status)}>{exp.status}</AppStatusPill>}
                          </div>
                        </div>
                        {(canPay || canMarkPaid || canDownload) && (
                          <div className="col-span-2 flex items-center justify-end gap-2 pt-1">
                            {canDownload && (exp.td_payment_id ? (
                              <button type="button" onClick={() => handleDownloadPdf(exp)} disabled={downloadingId === exp.id} aria-label={t('expenseList.downloadPdf')} className="flex h-9 w-9 items-center justify-center rounded-full bg-zinc-100 text-zinc-600 disabled:opacity-50">
                                {downloadingId === exp.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                              </button>
                            ) : (
                              <a href={exp.attachment_url ?? '#'} target="_blank" rel="noopener noreferrer" aria-label={t('expenseList.downloadPdf')} className="flex h-9 w-9 items-center justify-center rounded-full bg-zinc-100 text-zinc-600">
                                <Download className="h-4 w-4" />
                              </a>
                            ))}
                            {canMarkPaid && (
                              <button type="button" onClick={() => setConfirmingPaidExpense(exp)} disabled={markingPaidId === exp.id} className="flex min-h-9 items-center gap-1.5 rounded-full bg-zinc-100 px-3.5 text-[13px] font-semibold text-zinc-800 disabled:opacity-50">
                                {markingPaidId === exp.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Banknote className="h-4 w-4" />}
                                {t('expenseList.markPaid')}
                              </button>
                            )}
                            {canPay && (
                              <button type="button" onClick={() => setPayingExpense(exp)} className="flex min-h-9 items-center gap-1.5 rounded-full bg-zinc-800 px-4 text-[13px] font-bold text-white">
                                <CreditCard className="h-4 w-4" aria-hidden="true" />
                                {t('expenseList.pay')}
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* TD Invoice Pay Modal */}
      {payingExpense && payingExpense.td_payment_id && (
        <TdPayModal
          paymentId={payingExpense.td_payment_id}
          invoiceNumber={payingExpense.invoice_number || payingExpense.internal_ref || 'Invoice'}
          amount={Number(payingExpense.amount_due ?? payingExpense.total)}
          currency={payingExpense.currency}
          onClose={() => setPayingExpense(null)}
        />
      )}

      {/* Mark-as-paid confirm — the row's checkmark icon has no label a client
          would recognize on sight (esp. on mobile, where nothing hovers), so
          this dialog spells the action out in plain words before it commits. */}
      {confirmingPaidExpense && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setConfirmingPaidExpense(null)}
        >
          <div
            className="bg-white rounded-xl shadow-xl max-w-sm w-full p-5"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <h3 className="text-base font-semibold text-zinc-900">
                {t('expenseList.markPaidConfirmTitle')}
              </h3>
              <FastTooltip label={t('common.cancel')}>
                <button
                  onClick={() => setConfirmingPaidExpense(null)}
                  className="text-zinc-400 hover:text-zinc-600 p-1 -m-1"
                  aria-label={t('common.cancel')}
                >
                  <X className="h-5 w-5" />
                </button>
              </FastTooltip>
            </div>
            <p className="mt-2 text-sm text-zinc-600">
              {t('expenseList.markPaidConfirmBody')
                .replace('{vendor}', confirmingPaidExpense.vendor_name)
                .replace('{amount}', `${confirmingPaidExpense.currency === 'EUR' ? '€' : '$'}${Number(confirmingPaidExpense.total).toLocaleString('en-US', { minimumFractionDigits: 2 })}`)}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setConfirmingPaidExpense(null)}
                className="px-4 py-2 text-sm border rounded-lg hover:bg-zinc-50"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={() => handleMarkPaid(confirmingPaidExpense)}
                className="px-4 py-2 text-sm bg-emerald-600 text-white rounded-lg hover:bg-emerald-700"
              >
                {t('expenseList.markPaid')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
