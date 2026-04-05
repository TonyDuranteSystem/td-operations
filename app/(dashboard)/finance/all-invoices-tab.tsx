'use client'

import { useState, useMemo } from 'react'
import { format, parseISO } from 'date-fns'
import {
  Search, FileText, Send, CheckCircle, Edit3,
  ChevronDown, ChevronUp, Building2, User,
} from 'lucide-react'

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
                    <div className="flex items-center justify-center gap-1">
                      {inv.status !== 'Paid' && (
                        <button
                          title="Mark Paid"
                          className="p-1.5 rounded-md hover:bg-emerald-100 text-emerald-600 transition-colors"
                        >
                          <CheckCircle className="w-4 h-4" />
                        </button>
                      )}
                      {['Draft', 'Sent', 'Overdue'].includes(inv.status) && (
                        <button
                          title="Send / Remind"
                          className="p-1.5 rounded-md hover:bg-blue-100 text-blue-600 transition-colors"
                        >
                          <Send className="w-4 h-4" />
                        </button>
                      )}
                      <button
                        title="Edit"
                        className="p-1.5 rounded-md hover:bg-zinc-100 text-zinc-500 transition-colors"
                      >
                        <Edit3 className="w-4 h-4" />
                      </button>
                    </div>
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
    </div>
  )
}
