'use client'

import { useState, useMemo, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { format, parseISO } from 'date-fns'
import {
  Search, FileText, Send, CheckCircle, Edit3, X, Plus,
  ChevronDown, ChevronUp, Building2, User, Ban, Loader2,
} from 'lucide-react'
import { toast } from 'sonner'
import { markInvoicePaid, voidInvoice, sendInvoiceReminder, updateInvoice, createUnifiedInvoiceDraft } from './actions'
import { InvoiceDialog } from '@/components/payments/invoice-dialog'

const STATUS_COLORS: Record<string, string> = {
  Paid: 'bg-emerald-100 text-emerald-700',
  Overdue: 'bg-red-100 text-red-700',
  Sent: 'bg-blue-100 text-blue-700',
  Draft: 'bg-zinc-100 text-zinc-600',
  Partial: 'bg-orange-100 text-orange-700',
}

const STATUS_FILTERS = ['All', 'Overdue', 'Sent', 'Paid', 'Partial', 'Draft'] as const

type SortField = 'invoice_number' | 'client' | 'total' | 'status' | 'issue_date' | 'due_date'
type SortDir = 'asc' | 'desc'

export interface InvoiceRecord {
  id: string
  invoice_number: string
  status: string
  total: number
  amount_paid: number
  amount_due: number
  currency: string
  issue_date: string | null
  due_date: string | null
  paid_date: string | null
  notes: string | null
  account_id: string | null
  contact_id: string | null
  accounts: { company_name: string } | null
  contacts: { full_name: string } | null
}

function formatCurrency(amount: number, currency = 'USD') {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(amount)
}

function formatDate(dateStr: string | null) {
  if (!dateStr) return '—'
  try {
    return format(parseISO(dateStr), 'MMM d, yyyy')
  } catch {
    return '—'
  }
}

function getClientName(inv: InvoiceRecord): string {
  return inv.accounts?.company_name ?? inv.contacts?.full_name ?? '—'
}

export function AllInvoicesTab({ invoices }: { invoices: InvoiceRecord[] }) {
  const [search, setSearch] = useState('')
  const [showNewInvoice, setShowNewInvoice] = useState(false)
  const newInvRouter = useRouter()
  const [statusFilter, setStatusFilter] = useState<string>('All')
  const [sortField, setSortField] = useState<SortField>('issue_date')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  // Counts per status
  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = { All: invoices.length }
    for (const inv of invoices) {
      counts[inv.status] = (counts[inv.status] ?? 0) + 1
    }
    return counts
  }, [invoices])

  // Summary stats
  const summaryStats = useMemo(() => {
    let outstanding = 0
    let overdueAmount = 0
    let overdueCount = 0
    for (const inv of invoices) {
      if (['Sent', 'Overdue', 'Partial'].includes(inv.status)) {
        outstanding += Number(inv.amount_due ?? inv.total ?? 0)
      }
      if (inv.status === 'Overdue') {
        overdueAmount += Number(inv.amount_due ?? inv.total ?? 0)
        overdueCount++
      }
    }
    return { total: invoices.length, outstanding, overdueAmount, overdueCount }
  }, [invoices])

  // Filter + search + sort
  const filtered = useMemo(() => {
    let list = invoices

    // Status filter
    if (statusFilter !== 'All') {
      list = list.filter(inv => inv.status === statusFilter)
    }

    // Search
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter(inv =>
        inv.invoice_number?.toLowerCase().includes(q) ||
        getClientName(inv).toLowerCase().includes(q) ||
        inv.notes?.toLowerCase().includes(q)
      )
    }

    // Sort
    list = [...list].sort((a, b) => {
      let cmp = 0
      switch (sortField) {
        case 'invoice_number':
          cmp = (a.invoice_number ?? '').localeCompare(b.invoice_number ?? '')
          break
        case 'client':
          cmp = getClientName(a).localeCompare(getClientName(b))
          break
        case 'total':
          cmp = Number(a.total ?? 0) - Number(b.total ?? 0)
          break
        case 'status':
          cmp = (a.status ?? '').localeCompare(b.status ?? '')
          break
        case 'issue_date':
          cmp = (a.issue_date ?? '').localeCompare(b.issue_date ?? '')
          break
        case 'due_date': {
          const aDate = a.paid_date ?? a.due_date ?? ''
          const bDate = b.paid_date ?? b.due_date ?? ''
          cmp = aDate.localeCompare(bDate)
          break
        }
      }
      return sortDir === 'asc' ? cmp : -cmp
    })

    return list
  }, [invoices, statusFilter, search, sortField, sortDir])

  function toggleSort(field: SortField) {
    if (sortField === field) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortField(field)
      setSortDir('desc')
    }
  }

  function SortIcon({ field }: { field: SortField }) {
    if (sortField !== field) return null
    return sortDir === 'asc'
      ? <ChevronUp className="w-3 h-3 inline ml-1" />
      : <ChevronDown className="w-3 h-3 inline ml-1" />
  }

  return (
    <div className="p-6 space-y-4">
      {/* Summary bar */}
      <div className="flex items-center gap-6 text-sm text-muted-foreground bg-muted/50 rounded-lg px-4 py-3">
        <span>Total: <strong className="text-foreground">{summaryStats.total}</strong> invoices</span>
        <span>Outstanding: <strong className="text-foreground">{formatCurrency(summaryStats.outstanding)}</strong></span>
        {summaryStats.overdueCount > 0 && (
          <span className="text-red-600">
            Overdue: <strong>{formatCurrency(summaryStats.overdueAmount)}</strong> ({summaryStats.overdueCount} invoices)
          </span>
        )}
        <button
          onClick={() => setShowNewInvoice(true)}
          className="ml-auto flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white text-xs font-medium rounded-lg hover:bg-blue-700 transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          New Invoice
        </button>
      </div>

      {/* Search + status filter */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search by invoice #, client, or description..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div className="flex gap-1 flex-wrap">
          {STATUS_FILTERS.map(s => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                statusFilter === s
                  ? 'bg-blue-600 text-white'
                  : 'bg-muted text-muted-foreground hover:bg-muted/80'
              }`}
            >
              {s} {statusCounts[s] != null ? `(${statusCounts[s]})` : '(0)'}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="border rounded-lg overflow-auto max-h-[calc(100vh-320px)]">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 sticky top-0">
            <tr>
              <th className="text-left px-4 py-3 font-medium cursor-pointer select-none" onClick={() => toggleSort('invoice_number')}>
                Invoice # <SortIcon field="invoice_number" />
              </th>
              <th className="text-left px-4 py-3 font-medium cursor-pointer select-none" onClick={() => toggleSort('client')}>
                Client <SortIcon field="client" />
              </th>
              <th className="text-left px-4 py-3 font-medium">Description</th>
              <th className="text-right px-4 py-3 font-medium cursor-pointer select-none" onClick={() => toggleSort('total')}>
                Amount <SortIcon field="total" />
              </th>
              <th className="text-left px-4 py-3 font-medium cursor-pointer select-none" onClick={() => toggleSort('status')}>
                Status <SortIcon field="status" />
              </th>
              <th className="text-left px-4 py-3 font-medium cursor-pointer select-none" onClick={() => toggleSort('issue_date')}>
                Issue Date <SortIcon field="issue_date" />
              </th>
              <th className="text-left px-4 py-3 font-medium cursor-pointer select-none" onClick={() => toggleSort('due_date')}>
                Due / Paid <SortIcon field="due_date" />
              </th>
              <th className="text-center px-4 py-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {filtered.length === 0 && (
              <tr>
                <td colSpan={8} className="text-center py-12 text-muted-foreground">
                  <FileText className="w-8 h-8 mx-auto mb-2 opacity-40" />
                  No invoices found
                </td>
              </tr>
            )}
            {filtered.map(inv => {
              const isOverdue = inv.status === 'Overdue'
              const clientName = getClientName(inv)
              const hasAccount = !!inv.accounts?.company_name

              return (
                <tr
                  key={inv.id}
                  className={`hover:bg-muted/30 transition-colors ${isOverdue ? 'bg-red-50/50' : ''}`}
                >
                  <td className="px-4 py-3">
                    <span className="font-mono text-blue-600 text-xs">
                      {inv.invoice_number}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5">
                      {hasAccount
                        ? <Building2 className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                        : <User className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                      }
                      <span className="truncate max-w-[200px]">{clientName}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    <span className="truncate block max-w-[200px]" title={inv.notes ?? ''}>
                      {inv.notes ? (inv.notes.length > 50 ? inv.notes.slice(0, 50) + '...' : inv.notes) : '—'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-medium tabular-nums">
                    {formatCurrency(Number(inv.total ?? 0), inv.currency || 'USD')}
                    {inv.status === 'Partial' && inv.amount_paid > 0 && (
                      <div className="text-xs text-emerald-600">
                        {formatCurrency(Number(inv.amount_paid), inv.currency || 'USD')} paid
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[inv.status] ?? 'bg-zinc-100 text-zinc-600'}`}>
                      {inv.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground tabular-nums">
                    {formatDate(inv.issue_date)}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground tabular-nums">
                    {inv.status === 'Paid' ? formatDate(inv.paid_date) : formatDate(inv.due_date)}
                  </td>
                  <td className="px-4 py-3">
                    <InvoiceActions invoice={inv} />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Footer count */}
      <div className="text-xs text-muted-foreground text-right">
        Showing {filtered.length} of {invoices.length} invoices
      </div>

      {/* New Invoice Dialog */}
      <InvoiceDialog
        open={showNewInvoice}
        onClose={() => {
          setShowNewInvoice(false)
          newInvRouter.refresh()
        }}
        onCreateInvoice={async (input) => {
          const result = await createUnifiedInvoiceDraft({
            account_id: input.account_id,
            description: input.description,
            currency: (input.amount_currency || 'USD') as 'USD' | 'EUR',
            due_date: input.due_date,
            message: input.message,
            payment_method: input.payment_method,
            bank_preference: input.bank_preference,
            items: input.items,
          })
          return result
        }}
      />
    </div>
  )
}

// ── Invoice Action Buttons ──

// ── Styled Tooltip Button ──

function ActionButton({ onClick, label, icon: Icon, color, hoverBg }: {
  onClick?: () => void; label: string; icon: typeof CheckCircle; color: string; hoverBg: string
}) {
  return (
    <div className="relative group">
      <button onClick={onClick} className={`p-1.5 rounded-md ${hoverBg} ${color} transition-colors`}>
        <Icon className="w-4 h-4" />
      </button>
      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2 py-1 bg-zinc-900 text-white text-[10px] rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50">
        {label}
        <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-zinc-900" />
      </div>
    </div>
  )
}

// ── Invoice Actions ──

function InvoiceActions({ invoice }: { invoice: InvoiceRecord }) {
  const [isPending, startTransition] = useTransition()
  const [editing, setEditing] = useState(false)
  const router = useRouter()
  const { id: invoiceId, invoice_number: invoiceNumber, status } = invoice

  const handleMarkPaid = () => {
    if (!window.confirm(`Mark ${invoiceNumber} as Paid?`)) return
    startTransition(async () => {
      const result = await markInvoicePaid(invoiceId)
      if (result.success) { toast.success(`${invoiceNumber} marked as Paid`); router.refresh() }
      else toast.error(result.error ?? 'Failed')
    })
  }

  const handleSendReminder = () => {
    if (!window.confirm(`Send payment reminder for ${invoiceNumber}?`)) return
    startTransition(async () => {
      const result = await sendInvoiceReminder(invoiceId)
      if (result.success) { toast.success(`Reminder sent for ${invoiceNumber}`); router.refresh() }
      else toast.error(result.error ?? 'Failed')
    })
  }

  const handleVoid = () => {
    if (!window.confirm(`Void invoice ${invoiceNumber}? This cannot be undone.`)) return
    startTransition(async () => {
      const result = await voidInvoice(invoiceId)
      if (result.success) { toast.success(`${invoiceNumber} voided`); router.refresh() }
      else toast.error(result.error ?? 'Failed')
    })
  }

  if (isPending) {
    return <div className="flex justify-center"><Loader2 className="w-4 h-4 animate-spin text-muted-foreground" /></div>
  }

  return (
    <>
      <div className="flex items-center justify-center gap-0.5">
        {status !== 'Paid' && status !== 'Cancelled' && (
          <ActionButton onClick={handleMarkPaid} label="Mark as Paid" icon={CheckCircle} color="text-emerald-600" hoverBg="hover:bg-emerald-100" />
        )}
        {['Draft', 'Sent', 'Overdue', 'Partial'].includes(status) && (
          <ActionButton onClick={handleSendReminder} label="Send Reminder Email" icon={Send} color="text-blue-600" hoverBg="hover:bg-blue-100" />
        )}
        {status !== 'Paid' && status !== 'Cancelled' && (
          <ActionButton onClick={handleVoid} label="Void / Cancel Invoice" icon={Ban} color="text-red-500" hoverBg="hover:bg-red-100" />
        )}
        <ActionButton onClick={() => setEditing(true)} label="Edit Invoice" icon={Edit3} color="text-zinc-500" hoverBg="hover:bg-zinc-100" />
      </div>
      {editing && (
        <EditInvoiceDialog invoice={invoice} onClose={() => setEditing(false)} />
      )}
    </>
  )
}

// ── Edit Invoice Dialog ──

function EditInvoiceDialog({ invoice, onClose }: { invoice: InvoiceRecord; onClose: () => void }) {
  const [isPending, startTransition] = useTransition()
  const router = useRouter()
  const [dueDate, setDueDate] = useState(invoice.due_date ?? '')
  const [notes, setNotes] = useState(invoice.notes ?? '')
  const [message, setMessage] = useState((invoice as unknown as Record<string, string>).message ?? '')
  const [total, setTotal] = useState(String(invoice.total ?? 0))

  const handleSave = () => {
    startTransition(async () => {
      const updates: Record<string, unknown> = {}
      if (dueDate !== (invoice.due_date ?? '')) updates.due_date = dueDate
      if (notes !== (invoice.notes ?? '')) updates.notes = notes
      if (message !== ((invoice as unknown as Record<string, string>).message ?? '')) updates.message = message
      const newTotal = parseFloat(total)
      if (!isNaN(newTotal) && newTotal !== Number(invoice.total)) updates.total = newTotal

      if (Object.keys(updates).length === 0) { onClose(); return }

      const result = await updateInvoice(invoice.id, updates as { due_date?: string; notes?: string; message?: string; total?: number })
      if (result.success) {
        toast.success(`${invoice.invoice_number} updated`)
        router.refresh()
        onClose()
      } else {
        toast.error(result.error ?? 'Failed to update')
      }
    })
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg p-6 space-y-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-lg">Edit {invoice.invoice_number}</h3>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground block mb-1">Client</label>
            <p className="text-sm font-medium">
              {(invoice.accounts as unknown as { company_name: string })?.company_name
                ?? (invoice.contacts as unknown as { full_name: string })?.full_name
                ?? '—'}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground block mb-1">Amount ({invoice.currency || 'USD'})</label>
              <input
                type="number"
                step="0.01"
                value={total}
                onChange={e => setTotal(e.target.value)}
                className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground block mb-1">Due Date</label>
              <input
                type="date"
                value={dueDate}
                onChange={e => setDueDate(e.target.value)}
                className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground block mb-1">Payment Terms <span className="text-amber-600">(visible to client in portal)</span></label>
            <textarea
              value={message}
              onChange={e => setMessage(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              placeholder="Payment terms visible to client (e.g. 'Net 30', 'Due upon receipt')"
            />
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground block mb-1">Internal Notes</label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              placeholder="Internal notes (not visible to client)"
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="px-4 py-2 text-sm rounded-lg border hover:bg-zinc-50">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={isPending}
            className="px-4 py-2 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
          >
            {isPending && <Loader2 className="w-3 h-3 animate-spin" />}
            Save Changes
          </button>
        </div>
      </div>
    </div>
  )
}
