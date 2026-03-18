'use client'

import { useState } from 'react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { format, parseISO } from 'date-fns'
import { Eye, Search } from 'lucide-react'

interface Invoice {
  id: string
  invoice_number: string
  customer_name: string
  status: string
  currency: string
  total: number
  issue_date: string
  due_date: string | null
  paid_date: string | null
}

const STATUS_COLORS: Record<string, string> = {
  Draft: 'bg-zinc-100 text-zinc-700',
  Sent: 'bg-blue-100 text-blue-700',
  Paid: 'bg-emerald-100 text-emerald-700',
  Overdue: 'bg-red-100 text-red-700',
  Cancelled: 'bg-zinc-100 text-zinc-500',
}

const STATUS_TABS = ['All', 'Draft', 'Sent', 'Paid', 'Overdue']

export function InvoiceList({ invoices }: { invoices: Invoice[] }) {
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('All')

  const filtered = invoices.filter(inv => {
    if (statusFilter !== 'All' && inv.status !== statusFilter) return false
    if (search) {
      const q = search.toLowerCase()
      return inv.invoice_number.toLowerCase().includes(q) ||
        inv.customer_name.toLowerCase().includes(q)
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
            placeholder="Search by number or customer..."
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
              {tab}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
        <div className="hidden md:grid md:grid-cols-[1fr,140px,100px,100px,100px,60px] gap-3 px-4 py-3 border-b bg-zinc-50 text-xs font-medium text-zinc-500 uppercase">
          <span>Customer</span>
          <span>Invoice #</span>
          <span className="text-right">Amount</span>
          <span>Date</span>
          <span>Status</span>
          <span></span>
        </div>
        {filtered.length === 0 ? (
          <div className="p-8 text-center text-sm text-zinc-500">No invoices found</div>
        ) : (
          filtered.map(inv => (
            <div key={inv.id} className="grid grid-cols-1 md:grid-cols-[1fr,140px,100px,100px,100px,60px] gap-1 md:gap-3 px-4 py-3 border-b last:border-b-0 items-center text-sm hover:bg-zinc-50/50 transition-colors">
              <span className="font-medium truncate">{inv.customer_name}</span>
              <span className="text-zinc-600 text-xs">{inv.invoice_number}</span>
              <span className="text-right font-medium">
                {inv.currency === 'EUR' ? '\u20AC' : '$'}
                {Number(inv.total).toLocaleString('en-US', { minimumFractionDigits: 2 })}
              </span>
              <span className="text-xs text-zinc-500">
                {format(parseISO(inv.issue_date), 'MMM d, yy')}
              </span>
              <span>
                <span className={cn('text-xs px-2 py-0.5 rounded-full', STATUS_COLORS[inv.status] ?? 'bg-zinc-100')}>
                  {inv.status}
                </span>
              </span>
              <Link
                href={`/portal/invoices/${inv.id}`}
                className="p-1.5 rounded-lg hover:bg-blue-50 text-zinc-400 hover:text-blue-600 transition-colors"
              >
                <Eye className="h-4 w-4" />
              </Link>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
