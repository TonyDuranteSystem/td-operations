'use client'

import { useState } from 'react'
import { Search, User, Mail, Receipt, ChevronRight } from 'lucide-react'
import Link from 'next/link'

interface Customer {
  id: string
  name: string
  email: string | null
  address: string | null
  vat_number: string | null
}

interface CustomerListProps {
  customers: Customer[]
  invoiceCounts: Record<string, number>
}

export function CustomerList({ customers, invoiceCounts }: CustomerListProps) {
  const [search, setSearch] = useState('')

  const filtered = customers.filter(c =>
    c.name.toLowerCase().includes(search.toLowerCase()) ||
    (c.email && c.email.toLowerCase().includes(search.toLowerCase()))
  )

  return (
    <div className="space-y-4">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search customers..."
          className="w-full pl-10 pr-4 py-2.5 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <div className="bg-white rounded-xl border shadow-sm divide-y">
        {filtered.map(customer => (
          <Link
            key={customer.id}
            href={`/portal/customers/${customer.id}`}
            className="flex items-center justify-between p-4 hover:bg-zinc-50 transition-colors"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center shrink-0">
                <User className="h-5 w-5 text-blue-600" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-zinc-900">{customer.name}</p>
                <div className="flex items-center gap-3 text-xs text-zinc-500 mt-0.5">
                  {customer.email && (
                    <span className="flex items-center gap-1 truncate">
                      <Mail className="h-3 w-3" />
                      {customer.email}
                    </span>
                  )}
                  {invoiceCounts[customer.id] > 0 && (
                    <span className="flex items-center gap-1">
                      <Receipt className="h-3 w-3" />
                      {invoiceCounts[customer.id]} invoice{invoiceCounts[customer.id] > 1 ? 's' : ''}
                    </span>
                  )}
                </div>
              </div>
            </div>
            <ChevronRight className="h-4 w-4 text-zinc-300 shrink-0" />
          </Link>
        ))}
        {filtered.length === 0 && (
          <div className="p-8 text-center text-sm text-zinc-400">No customers match your search</div>
        )}
      </div>
    </div>
  )
}
