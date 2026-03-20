'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import {
  AlertCircle,
  Clock,
  CheckCircle2,
  Calendar,
  Check,
  Loader2,
  ChevronLeft,
  ChevronRight,
  Plus,
  FileText,
  Send,
  Download,
  Bell,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { differenceInDays, parseISO, format } from 'date-fns'
import { toast } from 'sonner'
import Link from 'next/link'
import { markPaymentPaid } from '@/app/(dashboard)/payments/actions'
import { EditPaymentDialog } from '@/components/payments/edit-payment-dialog'
import { CreatePaymentDialog } from '@/components/payments/create-payment-dialog'
import { InvoiceDialog } from '@/components/payments/invoice-dialog'

interface PaymentItem {
  id: string
  account_id: string
  description: string | null
  amount: string | number
  amount_currency: string | null
  period: string | null
  year: number | null
  due_date: string | null
  paid_date: string | null
  status: string | null
  payment_method: string | null
  installment: string | null
  amount_paid: string | number | null
  amount_due: string | number | null
  followup_stage: string | null
  delay_approved_until: string | null
  company_name: string | null
  updated_at: string
  notes?: string | null
  invoice_status?: string | null
  invoice_number?: string | null
  issue_date?: string | null
  total?: string | number | null
  sent_at?: string | null
  qb_sync_status?: string | null
}

interface PaymentBoardProps {
  overdue: PaymentItem[]
  upcoming: PaymentItem[]
  paid: PaymentItem[]
  invoices: PaymentItem[]
  stats: {
    overdueCount: number
    overdueTotal: number
    upcomingCount: number
    upcomingTotal: number
    paidCount: number
    paidTotal: number
    invoiceCount: number
  }
  activeTab: string
  today: string
}

const INVOICE_STATUS_COLORS: Record<string, string> = {
  Draft: 'bg-zinc-100 text-zinc-600',
  Sent: 'bg-blue-100 text-blue-700',
  Paid: 'bg-emerald-100 text-emerald-700',
  Overdue: 'bg-red-100 text-red-700',
  Voided: 'bg-zinc-200 text-zinc-500 line-through',
  Credit: 'bg-purple-100 text-purple-700',
}

const QB_SYNC_ICONS: Record<string, string> = {
  synced: '✓',
  error: '✗',
  pending: '…',
  skipped: '—',
}

const FOLLOWUP_COLORS: Record<string, string> = {
  'Day 7': 'bg-amber-100 text-amber-700',
  'Day 14': 'bg-orange-100 text-orange-700',
  'Day 21': 'bg-orange-100 text-orange-800',
  'Day 30': 'bg-red-100 text-red-700',
  'Day 45': 'bg-red-100 text-red-800',
  'Day 60': 'bg-red-200 text-red-900',
}

function formatCurrency(amount: string | number | null, currency?: string | null): string {
  if (amount == null) return '—'
  const num = typeof amount === 'string' ? parseFloat(amount) : amount
  if (isNaN(num)) return '—'
  const c = currency === 'EUR' ? '€' : '$'
  return `${c}${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function formatDate(d: string | null): string {
  if (!d) return '—'
  try {
    return format(parseISO(d), 'dd/MM/yyyy')
  } catch {
    return d
  }
}

function getOverdueBucket(dueDate: string | null, today: string): { label: string; color: string } {
  if (!dueDate) return { label: 'N/D', color: 'bg-zinc-100 text-zinc-600' }
  const days = differenceInDays(parseISO(today), parseISO(dueDate))
  if (days <= 0) return { label: 'Non scaduto', color: 'bg-zinc-100 text-zinc-600' }
  if (days <= 7) return { label: `${days}g`, color: 'bg-amber-100 text-amber-700' }
  if (days <= 14) return { label: `${days}g`, color: 'bg-amber-200 text-amber-800' }
  if (days <= 30) return { label: `${days}g`, color: 'bg-orange-100 text-orange-700' }
  if (days <= 45) return { label: `${days}g`, color: 'bg-red-100 text-red-700' }
  return { label: `${days}g`, color: 'bg-red-200 text-red-900' }
}

function MarkPaidButton({ paymentId, description }: { paymentId: string; description: string }) {
  const [isPending, startTransition] = useTransition()

  return (
    <button
      disabled={isPending}
      onClick={(e) => {
        e.stopPropagation()
        startTransition(async () => {
          try {
            await markPaymentPaid(paymentId)
            toast.success(`Pagamento segnato come pagato`, { description })
          } catch {
            toast.error('Errore nel segnare il pagamento come pagato')
          }
        })
      }}
      className={cn(
        'inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded transition-colors shrink-0',
        isPending
          ? 'bg-zinc-100 text-zinc-400 cursor-not-allowed'
          : 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200'
      )}
      title="Segna come pagato"
    >
      {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
      <span className="hidden sm:inline">Pagato</span>
    </button>
  )
}

function InvoiceActions({ payment }: { payment: PaymentItem }) {
  const [isPending, startTransition] = useTransition()
  const status = payment.invoice_status

  const handleSend = (e: React.MouseEvent) => {
    e.stopPropagation()
    startTransition(async () => {
      try {
        const res = await fetch(`/api/invoices/${payment.id}/send`, { method: 'POST' })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? 'Send failed')
        toast.success(`Invoice ${payment.invoice_number} sent`)
        window.location.reload()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to send')
      }
    })
  }

  const handleRemind = (e: React.MouseEvent) => {
    e.stopPropagation()
    startTransition(async () => {
      try {
        const res = await fetch(`/api/invoices/${payment.id}/remind`, { method: 'POST' })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? 'Remind failed')
        toast.success(`Reminder sent for ${payment.invoice_number}`)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to send reminder')
      }
    })
  }

  const handleDownload = (e: React.MouseEvent) => {
    e.stopPropagation()
    window.open(`/api/invoices/${payment.id}/pdf`, '_blank')
  }

  return (
    <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
      {/* Download PDF — always available */}
      <button onClick={handleDownload} className="p-1 rounded hover:bg-zinc-100 text-zinc-400 hover:text-zinc-600" title="Download PDF">
        <Download className="h-3.5 w-3.5" />
      </button>

      {/* Send — only for Draft or Overdue */}
      {(status === 'Draft' || status === 'Overdue') && (
        <button onClick={handleSend} disabled={isPending} className="p-1 rounded hover:bg-blue-50 text-blue-500 hover:text-blue-700 disabled:opacity-40" title="Send Invoice">
          {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
        </button>
      )}

      {/* Remind — only for Sent or Overdue */}
      {(status === 'Sent' || status === 'Overdue') && (
        <button onClick={handleRemind} disabled={isPending} className="p-1 rounded hover:bg-amber-50 text-amber-500 hover:text-amber-700 disabled:opacity-40" title="Send Reminder">
          {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Bell className="h-3.5 w-3.5" />}
        </button>
      )}
    </div>
  )
}

const PAYMENTS_PER_PAGE = 30

export function PaymentBoard({ overdue, upcoming, paid, invoices, stats, activeTab, today }: PaymentBoardProps) {
  const router = useRouter()
  const [page, setPage] = useState(1)
  const [showCreate, setShowCreate] = useState(false)
  const [showInvoice, setShowInvoice] = useState(false)
  const [showCredit, setShowCredit] = useState(false)
  const [editingPayment, setEditingPayment] = useState<PaymentItem | null>(null)

  const tabs = [
    { key: 'scaduti', label: 'Scaduti', count: stats.overdueCount, icon: AlertCircle, color: 'text-red-600' },
    { key: 'arrivo', label: 'In Arrivo', count: stats.upcomingCount, icon: Clock, color: 'text-amber-600' },
    { key: 'pagati', label: 'Pagati', count: stats.paidCount, icon: CheckCircle2, color: 'text-emerald-600' },
    { key: 'invoices', label: 'Invoices', count: stats.invoiceCount, icon: FileText, color: 'text-blue-600' },
  ]

  const allPayments = activeTab === 'scaduti' ? overdue :
                      activeTab === 'arrivo' ? upcoming :
                      activeTab === 'invoices' ? invoices : paid
  const totalPages = Math.ceil(allPayments.length / PAYMENTS_PER_PAGE)
  const currentPayments = allPayments.slice((page - 1) * PAYMENTS_PER_PAGE, page * PAYMENTS_PER_PAGE)

  return (
    <div className="space-y-6">
      {/* Stats + New button */}
      <div className="flex gap-3 flex-wrap">
        <div className="bg-white rounded-lg border p-4 flex-1 min-w-[140px]">
          <p className="text-2xl font-semibold text-red-600">{formatCurrency(stats.overdueTotal)}</p>
          <p className="text-xs text-muted-foreground mt-1">{stats.overdueCount} pagamenti scaduti</p>
        </div>
        <div className="bg-white rounded-lg border p-4 flex-1 min-w-[140px]">
          <p className="text-2xl font-semibold text-amber-600">{formatCurrency(stats.upcomingTotal)}</p>
          <p className="text-xs text-muted-foreground mt-1">{stats.upcomingCount} in arrivo</p>
        </div>
        <div className="bg-white rounded-lg border p-4 flex-1 min-w-[140px]">
          <p className="text-2xl font-semibold text-emerald-600">{formatCurrency(stats.paidTotal)}</p>
          <p className="text-xs text-muted-foreground mt-1">{stats.paidCount} pagati</p>
        </div>
        {activeTab === 'invoices' ? (
          <div className="flex gap-2">
            <button
              onClick={() => setShowInvoice(true)}
              className="bg-white rounded-lg border p-4 flex items-center gap-2 hover:bg-zinc-50 transition-colors"
              title="New Invoice"
            >
              <FileText className="h-5 w-5 text-blue-600" />
              <span className="text-sm font-medium hidden sm:inline">Invoice</span>
            </button>
            <button
              onClick={() => setShowCredit(true)}
              className="bg-white rounded-lg border p-4 flex items-center gap-2 hover:bg-zinc-50 transition-colors"
              title="New Credit Note"
            >
              <FileText className="h-5 w-5 text-purple-600" />
              <span className="text-sm font-medium hidden sm:inline">Credit</span>
            </button>
          </div>
        ) : (
          <button
            onClick={() => setShowCreate(true)}
            className="bg-white rounded-lg border p-4 min-w-[48px] flex items-center justify-center hover:bg-zinc-50 transition-colors"
            title="Nuovo pagamento"
          >
            <Plus className="h-5 w-5 text-zinc-600" />
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="border-b overflow-x-auto">
        <div className="flex gap-1 -mb-px min-w-max">
          {tabs.map(tab => {
            const Icon = tab.icon
            return (
              <button
                key={tab.key}
                onClick={() => { setPage(1); router.push(`/payments?tab=${tab.key}`) }}
                className={cn(
                  'flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap',
                  activeTab === tab.key
                    ? 'border-blue-500 text-blue-600'
                    : 'border-transparent text-muted-foreground hover:text-foreground hover:border-zinc-300'
                )}
              >
                <Icon className="h-4 w-4" />
                {tab.label}
                <span className="text-xs px-1.5 py-0.5 rounded-full bg-zinc-100 text-zinc-600 ml-1">
                  {tab.count}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      {/* Payment list */}
      <div className="bg-white rounded-lg border overflow-hidden">
        {/* Desktop Header */}
        {activeTab === 'invoices' ? (
          <div className="hidden lg:grid lg:grid-cols-[100px,1fr,120px,100px,100px,80px,50px,80px] gap-3 px-4 py-2.5 border-b bg-zinc-50 text-xs font-medium text-muted-foreground uppercase tracking-wider">
            <span>Invoice #</span>
            <span>Description</span>
            <span>Account</span>
            <span className="text-right">Amount</span>
            <span>Due Date</span>
            <span>Status</span>
            <span className="text-center">QB</span>
            <span></span>
          </div>
        ) : (
          <div className="hidden lg:grid lg:grid-cols-[1fr,120px,100px,100px,80px,80px,70px] gap-3 px-4 py-2.5 border-b bg-zinc-50 text-xs font-medium text-muted-foreground uppercase tracking-wider">
            <span>Descrizione</span>
            <span>Azienda</span>
            <span className="text-right">Importo</span>
            <span>Scadenza</span>
            <span>Stato</span>
            <span>Follow-up</span>
            <span></span>
          </div>
        )}

        {currentPayments.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            Nessun pagamento
          </div>
        ) : (
          currentPayments.map(p => {
            const bucket = activeTab === 'scaduti' ? getOverdueBucket(p.due_date, today) : null
            const desc = p.description ?? (`${p.period ?? ''} ${p.year ?? ''}`.trim() || p.installment || '—')

            // Invoice-specific rendering
            if (activeTab === 'invoices') {
              return (
                <div key={p.id} onClick={() => setEditingPayment(p)} className="flex flex-col lg:grid lg:grid-cols-[100px,1fr,120px,100px,100px,80px,50px,80px] gap-1 lg:gap-3 px-4 py-3 border-b last:border-b-0 lg:items-center text-sm cursor-pointer hover:bg-zinc-50/50">
                  {/* Invoice # */}
                  <span className="font-mono text-xs text-blue-600">{p.invoice_number ?? '—'}</span>
                  {/* Description */}
                  <div className="min-w-0">
                    <p className="font-medium truncate">{desc}</p>
                    <p className="text-xs text-muted-foreground lg:hidden">
                      {p.company_name && <span>{p.company_name} · </span>}
                      {formatCurrency(p.total ?? p.amount, p.amount_currency)}
                    </p>
                  </div>
                  {/* Account */}
                  <div className="hidden lg:block">
                    {p.company_name ? (
                      <Link href={`/accounts/${p.account_id}`} className="text-xs text-muted-foreground hover:text-blue-600 truncate block">
                        {p.company_name}
                      </Link>
                    ) : <span className="text-xs text-muted-foreground">—</span>}
                  </div>
                  {/* Amount */}
                  <p className={cn('text-right font-medium hidden lg:block', p.invoice_status === 'Credit' && 'text-purple-600')}>
                    {p.invoice_status === 'Credit' ? '-' : ''}{formatCurrency(Math.abs(Number(p.total ?? p.amount)), p.amount_currency)}
                  </p>
                  {/* Due Date */}
                  <div className="hidden lg:block text-xs">
                    {p.due_date ? formatDate(p.due_date) : '—'}
                  </div>
                  {/* Status */}
                  <div className="hidden lg:block">
                    <span className={cn('text-xs font-medium px-1.5 py-0.5 rounded', INVOICE_STATUS_COLORS[p.invoice_status ?? ''] ?? 'bg-zinc-100')}>
                      {p.invoice_status}
                    </span>
                  </div>
                  {/* QB Sync */}
                  <div className="hidden lg:block text-center">
                    <span className={cn('text-xs', p.qb_sync_status === 'synced' ? 'text-emerald-600' : p.qb_sync_status === 'error' ? 'text-red-600' : 'text-zinc-400')} title={`QB: ${p.qb_sync_status ?? 'pending'}`}>
                      {QB_SYNC_ICONS[p.qb_sync_status ?? 'pending'] ?? '…'}
                    </span>
                  </div>
                  {/* Actions */}
                  <div className="hidden lg:flex justify-end">
                    <InvoiceActions payment={p} />
                  </div>
                </div>
              )
            }

            return (
              <div key={p.id} onClick={() => setEditingPayment(p)} className={cn(
                'flex flex-col lg:grid lg:grid-cols-[1fr,120px,100px,100px,80px,80px,70px] gap-1 lg:gap-3 px-4 py-3 border-b last:border-b-0 lg:items-center text-sm cursor-pointer',
                activeTab === 'scaduti' && bucket ? 'hover:bg-red-50/30' : 'hover:bg-zinc-50/50'
              )}>
                {/* Description + mobile info */}
                <div className="min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-medium truncate">{desc}</p>
                    {/* Mobile: quick action */}
                    <div className="lg:hidden">
                      {activeTab !== 'pagati' && (
                        <MarkPaidButton paymentId={p.id} description={String(desc)} />
                      )}
                    </div>
                  </div>
                  {/* Mobile: amount + company + due date */}
                  <div className="flex items-center gap-2 lg:hidden mt-1 text-xs text-muted-foreground flex-wrap">
                    <span className="font-semibold text-foreground">{formatCurrency(p.amount_due ?? p.amount, p.amount_currency)}</span>
                    {p.company_name && (
                      <Link href={`/accounts/${p.account_id}`} className="hover:text-blue-600 truncate">
                        {p.company_name}
                      </Link>
                    )}
                    {p.due_date && <span>· {formatDate(p.due_date)}</span>}
                    {bucket && (
                      <span className={cn('font-medium px-1.5 py-0.5 rounded', bucket.color)}>
                        {bucket.label}
                      </span>
                    )}
                  </div>
                </div>

                {/* Desktop columns */}
                <div className="hidden lg:block">
                  {p.company_name ? (
                    <Link href={`/accounts/${p.account_id}`} className="text-xs text-muted-foreground hover:text-blue-600 truncate block">
                      {p.company_name}
                    </Link>
                  ) : <span className="text-xs text-muted-foreground">—</span>}
                </div>
                <p className="text-right font-medium hidden lg:block">
                  {formatCurrency(p.amount_due ?? p.amount, p.amount_currency)}
                </p>
                <div className="hidden lg:flex items-center gap-1">
                  {p.due_date ? (
                    <><Calendar className="h-3 w-3 text-muted-foreground" /><span className="text-xs">{formatDate(p.due_date)}</span></>
                  ) : <span className="text-xs text-muted-foreground">N/D</span>}
                </div>
                <div className="hidden lg:block">
                  {activeTab === 'scaduti' && bucket ? (
                    <span className={cn('text-xs font-medium px-1.5 py-0.5 rounded', bucket.color)}>{bucket.label}</span>
                  ) : (
                    <span className={cn('text-xs px-1.5 py-0.5 rounded',
                      p.status === 'Paid' ? 'bg-emerald-100 text-emerald-700' :
                      p.status === 'Overdue' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'
                    )}>{p.status}</span>
                  )}
                </div>
                <div className="hidden lg:block">
                  {p.followup_stage ? (
                    <span className={cn('text-xs font-medium px-1.5 py-0.5 rounded', FOLLOWUP_COLORS[p.followup_stage] ?? 'bg-zinc-100')}>{p.followup_stage}</span>
                  ) : <span className="text-xs text-muted-foreground">—</span>}
                </div>
                <div className="hidden lg:flex justify-end">
                  {activeTab !== 'pagati' && (
                    <MarkPaidButton paymentId={p.id} description={String(desc)} />
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            {((page - 1) * PAYMENTS_PER_PAGE) + 1}–{Math.min(page * PAYMENTS_PER_PAGE, allPayments.length)} di {allPayments.length}
          </p>
          <div className="flex items-center gap-1">
            <button
              disabled={page <= 1}
              onClick={() => setPage(p => p - 1)}
              className={cn('p-1.5 rounded-lg', page <= 1 ? 'text-zinc-300 cursor-not-allowed' : 'text-zinc-600 hover:bg-zinc-100')}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
              <button
                key={p}
                onClick={() => setPage(p)}
                className={cn(
                  'px-2.5 py-1 rounded-lg text-xs font-medium transition-colors',
                  p === page ? 'bg-zinc-900 text-white' : 'text-zinc-600 hover:bg-zinc-100'
                )}
              >
                {p}
              </button>
            ))}
            <button
              disabled={page >= totalPages}
              onClick={() => setPage(p => p + 1)}
              className={cn('p-1.5 rounded-lg', page >= totalPages ? 'text-zinc-300 cursor-not-allowed' : 'text-zinc-600 hover:bg-zinc-100')}
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* Dialogs */}
      <CreatePaymentDialog
        open={showCreate}
        onClose={() => setShowCreate(false)}
      />
      <InvoiceDialog
        open={showInvoice}
        onClose={() => setShowInvoice(false)}
        mode="invoice"
      />
      <InvoiceDialog
        open={showCredit}
        onClose={() => setShowCredit(false)}
        mode="credit"
      />
      {editingPayment && (
        <EditPaymentDialog
          open={!!editingPayment}
          onClose={() => setEditingPayment(null)}
          payment={editingPayment}
        />
      )}
    </div>
  )
}
