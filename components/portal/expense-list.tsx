'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'
import { format, parseISO } from 'date-fns'
import { Search, FileText, Building2, Upload, PenLine, Download, Loader2, CreditCard } from 'lucide-react'
import { toast } from 'sonner'
import { TdPayModal } from './td-pay-modal'

interface Expense {
  id: string
  vendor_name: string
  invoice_number: string | null
  internal_ref: string | null
  description: string | null
  currency: string
  total: number
  issue_date: string | null
  due_date: string | null
  paid_date: string | null
  status: string
  source: string
  category: string | null
  attachment_url: string | null
  attachment_name: string | null
  td_payment_id: string | null
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

function fmtDate(d: string | null): string {
  if (!d) return '—'
  try { return format(parseISO(d), 'MMM d, yy') } catch { return d }
}

export function ExpenseList({
  expenses,
  locale,
  initialFilter = 'All',
}: {
  expenses: Expense[]
  locale: string
  initialFilter?: 'All' | 'Pending' | 'Paid' | 'Overdue'
}) {
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>(initialFilter)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [payingExpense, setPayingExpense] = useState<Expense | null>(null)

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
      toast.success('PDF downloaded')
    } catch {
      toast.error('Failed to download PDF')
    } finally {
      setDownloadingId(null)
    }
  }

  const isIt = locale === 'it'

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
      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={isIt ? 'Cerca per fornitore o numero...' : 'Search by vendor or number...'}
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
              {tab === 'All' ? (isIt ? 'Tutte' : 'All')
                : tab === 'Pending' ? (isIt ? 'Da Pagare' : 'Pending')
                : tab === 'Paid' ? (isIt ? 'Pagate' : 'Paid')
                : tab === 'Overdue' ? (isIt ? 'Scadute' : 'Overdue')
                : tab}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
        <div className="hidden md:grid md:grid-cols-[1fr,120px,100px,90px,80px,80px,80px] gap-3 px-4 py-3 border-b bg-zinc-50 text-xs font-medium text-zinc-500 uppercase">
          <span>{isIt ? 'Fornitore' : 'Vendor'}</span>
          <span>{isIt ? 'N. Fattura' : 'Invoice #'}</span>
          <span className="text-right">{isIt ? 'Importo' : 'Amount'}</span>
          <span>{isIt ? 'Data' : 'Date'}</span>
          <span>{isIt ? 'Stato' : 'Status'}</span>
          <span>{isIt ? 'Fonte' : 'Source'}</span>
          <span></span>
        </div>
        {filtered.length === 0 ? (
          <div className="p-8 text-center">
            <FileText className="h-10 w-10 text-zinc-300 mx-auto mb-2" />
            <p className="text-sm text-zinc-500">
              {isIt ? 'Nessuna spesa trovata' : 'No expenses found'}
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
                  {exp.attachment_url && (
                    <a href={exp.attachment_url} target="_blank" rel="noopener noreferrer" className="shrink-0 text-zinc-400 hover:text-blue-600">
                      <FileText className="h-3.5 w-3.5" />
                    </a>
                  )}
                </div>
                <span className="text-zinc-600 text-xs truncate">{exp.invoice_number || exp.internal_ref || '—'}</span>
                <span className="text-right font-medium">
                  {exp.currency === 'EUR' ? '\u20AC' : '$'}
                  {Number(exp.total).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                </span>
                <span className="text-xs text-zinc-500">
                  {fmtDate(exp.issue_date)}
                </span>
                <span>
                  <span className={cn('text-xs px-2 py-0.5 rounded-full', STATUS_COLORS[exp.status] ?? 'bg-zinc-100')}>
                    {exp.status}
                  </span>
                </span>
                <span>
                  <span className={cn('inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border', src.className)}>
                    <SourceIcon className="h-3 w-3" />
                    {src.label}
                  </span>
                </span>
                <span className="flex items-center justify-center gap-1">
                  {exp.source === 'td_invoice' && exp.td_payment_id && (exp.status === 'Pending' || exp.status === 'Overdue') && (
                    <button
                      onClick={() => setPayingExpense(exp)}
                      className="p-1 rounded hover:bg-blue-50 text-blue-600 hover:text-blue-700"
                      title={isIt ? 'Paga' : 'Pay'}
                    >
                      <CreditCard className="h-4 w-4" />
                    </button>
                  )}
                  {exp.td_payment_id ? (
                    <button
                      onClick={() => handleDownloadPdf(exp)}
                      disabled={downloadingId === exp.id}
                      className="p-1 rounded hover:bg-zinc-100 text-zinc-400 hover:text-blue-600 disabled:opacity-50"
                      title={isIt ? 'Scarica PDF' : 'Download PDF'}
                    >
                      {downloadingId === exp.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                    </button>
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

      {/* TD Invoice Pay Modal */}
      {payingExpense && payingExpense.td_payment_id && (
        <TdPayModal
          paymentId={payingExpense.td_payment_id}
          invoiceNumber={payingExpense.invoice_number || payingExpense.internal_ref || 'Invoice'}
          amount={Number(payingExpense.total)}
          currency={payingExpense.currency}
          locale={locale}
          onClose={() => setPayingExpense(null)}
        />
      )}
    </div>
  )
}
