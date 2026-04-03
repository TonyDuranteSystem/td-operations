'use client'

import { useState, useMemo } from 'react'

interface AgingRow {
  id: string
  invoice_number: string
  company_name: string
  customer_name: string
  status: string
  total: number
  amount_paid: number
  amount_due: number
  currency: string
  issue_date: string
  due_date: string | null
  paid_date: string | null
  days_overdue: number
}

function agingColor(daysOverdue: number, status: string): string {
  if (status === 'Paid') return ''
  if (status === 'Draft') return 'bg-gray-50'
  if (daysOverdue >= 60) return 'bg-red-50'
  if (daysOverdue >= 30) return 'bg-orange-50'
  if (daysOverdue >= 1) return 'bg-yellow-50'
  return 'bg-green-50'
}

function statusBadge(status: string) {
  const colors: Record<string, string> = {
    Paid: 'bg-green-100 text-green-800',
    Sent: 'bg-blue-100 text-blue-800',
    Overdue: 'bg-red-100 text-red-800',
    Partial: 'bg-orange-100 text-orange-800',
    Draft: 'bg-gray-100 text-gray-600',
  }
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${colors[status] ?? 'bg-gray-100 text-gray-600'}`}>
      {status}
    </span>
  )
}

export function InvoiceAgingTable({ rows }: { rows: AgingRow[] }) {
  const [filter, setFilter] = useState<'all' | 'outstanding' | 'overdue' | 'paid'>('outstanding')
  const [search, setSearch] = useState('')

  const filtered = useMemo(() => {
    let result = rows
    if (filter === 'outstanding') result = result.filter(r => ['Sent', 'Overdue', 'Partial'].includes(r.status))
    else if (filter === 'overdue') result = result.filter(r => r.status === 'Overdue' || (r.days_overdue > 0 && !['Paid', 'Draft'].includes(r.status)))
    else if (filter === 'paid') result = result.filter(r => r.status === 'Paid')

    if (search) {
      const q = search.toLowerCase()
      result = result.filter(r =>
        r.invoice_number.toLowerCase().includes(q) ||
        r.company_name.toLowerCase().includes(q) ||
        r.customer_name.toLowerCase().includes(q)
      )
    }
    return result
  }, [rows, filter, search])

  return (
    <div>
      {/* Filters */}
      <div className="flex flex-wrap gap-2 mb-4 items-center">
        {(['all', 'outstanding', 'overdue', 'paid'] as const).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              filter === f
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            {f.charAt(0).toUpperCase() + f.slice(1)} ({
              f === 'all' ? rows.length :
              f === 'outstanding' ? rows.filter(r => ['Sent', 'Overdue', 'Partial'].includes(r.status)).length :
              f === 'overdue' ? rows.filter(r => r.status === 'Overdue' || (r.days_overdue > 0 && !['Paid', 'Draft'].includes(r.status))).length :
              rows.filter(r => r.status === 'Paid').length
            })
          </button>
        ))}
        <input
          type="text"
          placeholder="Search by client, invoice..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="ml-auto px-3 py-1.5 rounded-md border text-sm w-64"
        />
      </div>

      {/* Table */}
      <div className="rounded-lg border overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="text-left px-4 py-3 font-medium">Client</th>
              <th className="text-left px-4 py-3 font-medium">Invoice #</th>
              <th className="text-right px-4 py-3 font-medium">Amount</th>
              <th className="text-right px-4 py-3 font-medium">Balance</th>
              <th className="text-left px-4 py-3 font-medium">Due Date</th>
              <th className="text-right px-4 py-3 font-medium">Days Overdue</th>
              <th className="text-left px-4 py-3 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">No invoices found</td></tr>
            )}
            {filtered.map(row => (
              <tr key={row.id} className={`border-b hover:bg-muted/30 ${agingColor(row.days_overdue, row.status)}`}>
                <td className="px-4 py-3 font-medium">{row.company_name}</td>
                <td className="px-4 py-3">{row.invoice_number}</td>
                <td className="px-4 py-3 text-right">${Number(row.total).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                <td className="px-4 py-3 text-right font-medium">
                  {row.status === 'Paid' ? '—' : `$${Number(row.amount_due ?? row.total).toLocaleString(undefined, { minimumFractionDigits: 2 })}`}
                </td>
                <td className="px-4 py-3">{row.due_date ?? '—'}</td>
                <td className="px-4 py-3 text-right">
                  {row.status === 'Paid' ? '—' : row.days_overdue > 0 ? (
                    <span className={row.days_overdue >= 60 ? 'text-red-600 font-bold' : row.days_overdue >= 30 ? 'text-orange-600 font-semibold' : 'text-yellow-600'}>
                      {row.days_overdue}d
                    </span>
                  ) : (
                    <span className="text-green-600">Current</span>
                  )}
                </td>
                <td className="px-4 py-3">{statusBadge(row.status)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
