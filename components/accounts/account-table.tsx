'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useState, useTransition } from 'react'
import { Search, Building2, AlertCircle, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { AccountListItem } from '@/lib/types'
import Link from 'next/link'

const ENTITY_COLORS: Record<string, string> = {
  'Single Member LLC': 'bg-blue-100 text-blue-700',
  'Multi Member LLC': 'bg-indigo-100 text-indigo-700',
  'C-Corp Elected': 'bg-violet-100 text-violet-700',
}

const HEALTH_COLORS: Record<string, string> = {
  Healthy: 'text-emerald-600',
  'At Risk': 'text-amber-600',
  Critical: 'text-red-600',
}

interface AccountTableProps {
  items: AccountListItem[]
  query: string
  statusFilter: string
  typeFilter: string
  stats: {
    total: number
    smllc: number
    mmllc: number
    corp: number
    withOverdue: number
  }
}

export function AccountTable({ items, query, statusFilter, typeFilter, stats }: AccountTableProps) {
  const router = useRouter()
  const [search, setSearch] = useState(query)
  const [isPending, startTransition] = useTransition()

  function updateFilter(key: string, value: string) {
    const params = new URLSearchParams()
    if (key === 'q') {
      if (value) params.set('q', value)
      if (statusFilter) params.set('status', statusFilter)
      if (typeFilter) params.set('type', typeFilter)
    } else if (key === 'status') {
      if (query) params.set('q', query)
      if (value) params.set('status', value)
      if (typeFilter) params.set('type', typeFilter)
    } else if (key === 'type') {
      if (query) params.set('q', query)
      if (statusFilter) params.set('status', statusFilter)
      if (value) params.set('type', value)
    }
    startTransition(() => {
      router.push(`/accounts?${params.toString()}`)
    })
  }

  function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    updateFilter('q', search)
  }

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <form onSubmit={handleSearch} className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Cerca azienda..."
            className="w-full pl-9 pr-4 py-2 rounded-lg border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </form>
        <select
          value={statusFilter}
          onChange={e => updateFilter('status', e.target.value)}
          className="px-3 py-2 rounded-lg border bg-white text-sm"
        >
          <option value="Active">Attivi</option>
          <option value="all">Tutti</option>
          <option value="Closed">Chiusi</option>
          <option value="Cancelled">Cancellati</option>
        </select>
        <select
          value={typeFilter}
          onChange={e => updateFilter('type', e.target.value)}
          className="px-3 py-2 rounded-lg border bg-white text-sm"
        >
          <option value="">Tutti i tipi</option>
          <option value="Single Member LLC">SMLLC</option>
          <option value="Multi Member LLC">MMLLC</option>
          <option value="C-Corp Elected">C-Corp</option>
        </select>
      </div>

      {/* Stats row */}
      <div className="flex gap-3 flex-wrap text-sm">
        <span className="px-3 py-1 rounded-full bg-zinc-100 text-zinc-700 font-medium">
          {stats.total} totali
        </span>
        {stats.withOverdue > 0 && (
          <span className="px-3 py-1 rounded-full bg-red-100 text-red-700 font-medium flex items-center gap-1">
            <AlertCircle className="h-3.5 w-3.5" />
            {stats.withOverdue} con pagamenti scaduti
          </span>
        )}
      </div>

      {/* Table */}
      <div className="bg-white rounded-lg border overflow-hidden">
        <div className={cn('transition-opacity', isPending && 'opacity-50')}>
          {/* Header */}
          <div className="hidden md:grid md:grid-cols-[1fr,140px,100px,120px,80px,80px,32px] gap-3 px-4 py-2.5 border-b bg-zinc-50 text-xs font-medium text-muted-foreground uppercase tracking-wider">
            <span>Azienda</span>
            <span>Contatto</span>
            <span>Tipo</span>
            <span>Stato</span>
            <span className="text-center">Servizi</span>
            <span className="text-center">Scaduti</span>
            <span></span>
          </div>

          {/* Rows */}
          {items.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              Nessun account trovato
            </div>
          ) : (
            items.map(item => (
              <Link
                key={item.id}
                href={`/accounts/${item.id}`}
                className="grid grid-cols-1 md:grid-cols-[1fr,140px,100px,120px,80px,80px,32px] gap-1 md:gap-3 px-4 py-3 border-b last:border-b-0 hover:bg-zinc-50 transition-colors items-center"
              >
                {/* Company */}
                <div className="flex items-center gap-2 min-w-0">
                  <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
                  <div className="min-w-0">
                    <p className="font-medium text-sm truncate">{item.company_name}</p>
                    {item.state_of_formation && (
                      <p className="text-xs text-muted-foreground">{item.state_of_formation}</p>
                    )}
                  </div>
                </div>

                {/* Contact */}
                <div className="text-xs text-muted-foreground truncate hidden md:block">
                  {item.contact_name ?? '—'}
                </div>

                {/* Entity type */}
                <div className="hidden md:block">
                  {item.entity_type && (
                    <span className={cn('text-xs font-medium px-1.5 py-0.5 rounded', ENTITY_COLORS[item.entity_type] ?? 'bg-zinc-100')}>
                      {item.entity_type === 'Single Member LLC' ? 'SMLLC' :
                       item.entity_type === 'Multi Member LLC' ? 'MMLLC' :
                       item.entity_type === 'C-Corp Elected' ? 'Corp' : item.entity_type}
                    </span>
                  )}
                </div>

                {/* Health */}
                <div className="hidden md:block">
                  {item.client_health && (
                    <span className={cn('text-xs font-medium', HEALTH_COLORS[item.client_health])}>
                      {item.client_health}
                    </span>
                  )}
                </div>

                {/* Services */}
                <div className="hidden md:flex justify-center">
                  {item.service_count > 0 && (
                    <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">
                      {item.service_count}
                    </span>
                  )}
                </div>

                {/* Overdue */}
                <div className="hidden md:flex justify-center">
                  {item.payment_overdue > 0 && (
                    <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-red-100 text-red-700">
                      {item.payment_overdue}
                    </span>
                  )}
                </div>

                {/* Arrow */}
                <div className="hidden md:flex justify-end">
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                </div>
              </Link>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
