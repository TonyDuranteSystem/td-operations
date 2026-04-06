'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'
import { ArrowUpRight, ArrowDownLeft, Download, ChevronDown, ChevronRight, FileText } from 'lucide-react'
import Link from 'next/link'

interface ArchiveItem {
  id: string
  direction: string
  invoice_number: string
  counterparty_name: string
  amount: number
  currency: string
  issue_date: string | null
  file_url: string | null
  file_name: string | null
  year: number
  month: number
  sales_invoice_id: string | null
  expense_id: string | null
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function groupByYearMonth(items: ArchiveItem[]): Map<number, Map<number, ArchiveItem[]>> {
  const groups = new Map<number, Map<number, ArchiveItem[]>>()
  for (const item of items) {
    if (!groups.has(item.year)) groups.set(item.year, new Map())
    const yearMap = groups.get(item.year)!
    if (!yearMap.has(item.month)) yearMap.set(item.month, [])
    yearMap.get(item.month)!.push(item)
  }
  return groups
}

export function InvoiceArchive({ items }: { items: ArchiveItem[] }) {
  const [expandedYears, setExpandedYears] = useState<number[]>(() => {
    // Default: expand the most recent year
    const years = Array.from(new Set(items.map(i => i.year)))
    return years.length > 0 ? [Math.max(...years)] : []
  })

  if (items.length === 0) return null

  const grouped = groupByYearMonth(items)

  const toggleYear = (year: number) => {
    setExpandedYears(prev =>
      prev.includes(year) ? prev.filter(y => y !== year) : [...prev, year]
    )
  }

  return (
    <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 px-5 py-4 border-b bg-zinc-50">
        <FileText className="h-4 w-4 text-zinc-500" />
        <span className="text-sm font-semibold text-zinc-800">Invoice Archive</span>
        <span className="text-xs text-zinc-400">{items.length} documents</span>
      </div>

      {Array.from(grouped.entries()).sort((a, b) => b[0] - a[0]).map(([year, months]) => (
        <div key={year}>
          <button
            onClick={() => toggleYear(year)}
            className="w-full flex items-center gap-2 px-5 py-3 text-sm font-medium text-zinc-700 hover:bg-zinc-50 border-b"
          >
            {expandedYears.includes(year) ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            {year}
            <span className="text-xs text-zinc-400">
              ({Array.from(months.values()).reduce((s, m) => s + m.length, 0)} invoices)
            </span>
          </button>

          {expandedYears.includes(year) && (
            <div>
              {Array.from(months.entries()).sort((a, b) => b[0] - a[0]).map(([month, docs]) => (
                <div key={month} className="border-b last:border-b-0">
                  <div className="px-5 py-2 bg-zinc-50/50 text-xs font-medium text-zinc-500 uppercase">
                    {MONTH_NAMES[month - 1]} {year}
                  </div>
                  {docs.map(doc => (
                    <div key={doc.id} className="flex items-center gap-3 px-5 py-2.5 text-sm hover:bg-zinc-50/50 group">
                      {doc.direction === 'sales' ? (
                        <ArrowUpRight className="h-4 w-4 text-emerald-500 shrink-0" />
                      ) : (
                        <ArrowDownLeft className="h-4 w-4 text-blue-500 shrink-0" />
                      )}
                      <div className="min-w-0 flex-1">
                        <span className="font-medium text-zinc-800">{doc.invoice_number}</span>
                        <span className="text-zinc-400 mx-1.5">—</span>
                        <Link
                          href={doc.direction === 'sales' && doc.sales_invoice_id
                            ? `/portal/invoices/${doc.sales_invoice_id}`
                            : '/portal/invoices?tab=expenses'}
                          className="text-zinc-600 hover:text-blue-600 hover:underline"
                        >
                          {doc.counterparty_name}
                        </Link>
                      </div>
                      <span className={cn('text-xs font-medium whitespace-nowrap', doc.direction === 'sales' ? 'text-emerald-600' : 'text-blue-600')}>
                        {doc.currency === 'EUR' ? '\u20AC' : '$'}{Number(doc.amount).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                      </span>
                      {doc.file_url && (
                        <a
                          href={doc.file_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="p-1.5 rounded-lg text-zinc-400 hover:text-blue-600 hover:bg-blue-50 opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          <Download className="h-3.5 w-3.5" />
                        </a>
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
