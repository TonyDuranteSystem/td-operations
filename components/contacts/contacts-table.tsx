'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { Search, ChevronRight, ChevronLeft, User, Building2, Shield } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ContactListItem } from '@/lib/types'

const TIER_COLORS: Record<string, string> = {
  'lead': 'bg-zinc-100 text-zinc-600',
  'onboarding': 'bg-amber-100 text-amber-700',
  'active': 'bg-emerald-100 text-emerald-700',
  'full': 'bg-blue-100 text-blue-700',
}

interface ContactsTableProps {
  items: ContactListItem[]
  query: string
  statusFilter: string
  stats: {
    total: number
    withAccounts: number
    withItin: number
    withPassport: number
  }
  currentPage: number
  totalPages: number
  totalCount: number
}

export function ContactsTable({ items, query, statusFilter, stats, currentPage, totalPages, totalCount }: ContactsTableProps) {
  const router = useRouter()
  const [search, setSearch] = useState(query)
  const [isPending, startTransition] = useTransition()

  function buildParams(overrides: Record<string, string> = {}) {
    const params = new URLSearchParams()
    const q = overrides.q ?? query
    const s = overrides.status ?? statusFilter
    const p = overrides.page ?? ''
    if (q) params.set('q', q)
    if (s && s !== 'all') params.set('status', s)
    if (p && p !== '1') params.set('page', p)
    return params.toString()
  }

  function updateFilter(key: string, value: string) {
    startTransition(() => {
      router.push(`/contacts?${buildParams({ [key]: value, page: '1' })}`)
    })
  }

  function goToPage(page: number) {
    startTransition(() => {
      router.push(`/contacts?${buildParams({ page: String(page) })}`)
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
            placeholder="Search name or email..."
            className="w-full pl-9 pr-4 py-2 rounded-lg border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </form>
        <select
          value={statusFilter}
          onChange={e => updateFilter('status', e.target.value)}
          className="px-3 py-2 rounded-lg border bg-white text-sm"
        >
          <option value="active">Active</option>
          <option value="all">All</option>
          <option value="inactive">Inactive</option>
        </select>
      </div>

      {/* Stats row */}
      <div className="flex gap-3 flex-wrap text-sm">
        <span className="px-3 py-1 rounded-full bg-zinc-100 text-zinc-700 font-medium">
          {stats.total} totali
        </span>
        <span className="px-3 py-1 rounded-full bg-blue-100 text-blue-700 font-medium">
          {stats.withAccounts} with LLCs
        </span>
        {stats.withItin > 0 && (
          <span className="px-3 py-1 rounded-full bg-indigo-100 text-indigo-700 font-medium">
            {stats.withItin} with ITIN
          </span>
        )}
      </div>

      {/* Table */}
      <div className="bg-white rounded-lg border overflow-hidden">
        <div className={cn('transition-opacity', isPending && 'opacity-50')}>
          {/* Header */}
          <div className="hidden md:grid md:grid-cols-[1fr,180px,100px,80px,1fr,32px] gap-3 px-4 py-2.5 border-b bg-zinc-50 text-xs font-medium text-muted-foreground uppercase tracking-wider">
            <span>Name</span>
            <span>Email</span>
            <span>Citizenship</span>
            <span>Tier</span>
            <span>Accounts</span>
            <span></span>
          </div>

          {/* Rows */}
          {items.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              No contacts found
            </div>
          ) : (
            items.map(item => (
              <div
                key={item.id}
                onClick={() => router.push(`/contacts/${item.id}`)}
                role="button"
                tabIndex={0}
                onKeyDown={e => e.key === 'Enter' && router.push(`/contacts/${item.id}`)}
                className="grid grid-cols-1 md:grid-cols-[1fr,180px,100px,80px,1fr,32px] gap-1 md:gap-3 px-4 py-3 border-b last:border-b-0 hover:bg-zinc-50 transition-colors items-center cursor-pointer"
              >
                {/* Name */}
                <div className="flex items-center gap-2 min-w-0">
                  <User className="h-4 w-4 text-muted-foreground shrink-0" />
                  <div className="min-w-0">
                    <p className="font-medium text-sm truncate">{item.full_name}</p>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      {item.language && <span>{item.language}</span>}
                      {item.passport_on_file && (
                        <span className="flex items-center gap-0.5 text-emerald-600">
                          <Shield className="h-3 w-3" />
                          ID
                        </span>
                      )}
                      {item.itin_number && (
                        <span className="text-indigo-600">ITIN</span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Email */}
                <div className="hidden md:block text-xs text-muted-foreground truncate">
                  {item.email ?? '—'}
                </div>

                {/* Citizenship */}
                <div className="hidden md:block text-xs text-muted-foreground">
                  {item.citizenship ?? '—'}
                </div>

                {/* Tier */}
                <div className="hidden md:block">
                  {item.portal_tier && (
                    <span className={cn('text-xs font-medium px-1.5 py-0.5 rounded', TIER_COLORS[item.portal_tier] ?? 'bg-zinc-100')}>
                      {item.portal_tier}
                    </span>
                  )}
                </div>

                {/* Accounts */}
                <div className="hidden md:flex items-center gap-1.5 text-xs text-muted-foreground min-w-0">
                  {item.account_count > 0 ? (
                    <>
                      <Building2 className="h-3 w-3 shrink-0" />
                      <span className="truncate">{item.account_names}</span>
                      {item.account_count > 1 && (
                        <span className="shrink-0 px-1.5 py-0.5 rounded-full bg-zinc-100 text-zinc-600 font-medium">
                          {item.account_count}
                        </span>
                      )}
                    </>
                  ) : (
                    <span>No accounts</span>
                  )}
                </div>

                {/* Arrow */}
                <div className="hidden md:flex justify-end">
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between pt-2">
          <p className="text-xs text-muted-foreground">
            {((currentPage - 1) * 50) + 1}–{Math.min(currentPage * 50, totalCount)} di {totalCount}
          </p>
          <div className="flex items-center gap-1">
            <button
              disabled={currentPage <= 1 || isPending}
              onClick={() => goToPage(currentPage - 1)}
              className={cn(
                'p-1.5 rounded-lg text-sm transition-colors',
                currentPage <= 1 || isPending
                  ? 'text-zinc-300 cursor-not-allowed'
                  : 'text-zinc-600 hover:bg-zinc-100'
              )}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            {Array.from({ length: totalPages }, (_, i) => i + 1)
              .filter(p => p === 1 || p === totalPages || Math.abs(p - currentPage) <= 1)
              .reduce<(number | string)[]>((acc, p, i, arr) => {
                if (i > 0 && p - (arr[i - 1] as number) > 1) acc.push('...')
                acc.push(p)
                return acc
              }, [])
              .map((p, i) =>
                typeof p === 'string' ? (
                  <span key={`dots-${i}`} className="px-1 text-xs text-muted-foreground">…</span>
                ) : (
                  <button
                    key={p}
                    disabled={isPending}
                    onClick={() => goToPage(p)}
                    className={cn(
                      'px-2.5 py-1 rounded-lg text-xs font-medium transition-colors',
                      p === currentPage
                        ? 'bg-zinc-900 text-white'
                        : 'text-zinc-600 hover:bg-zinc-100'
                    )}
                  >
                    {p}
                  </button>
                )
              )}
            <button
              disabled={currentPage >= totalPages || isPending}
              onClick={() => goToPage(currentPage + 1)}
              className={cn(
                'p-1.5 rounded-lg text-sm transition-colors',
                currentPage >= totalPages || isPending
                  ? 'text-zinc-300 cursor-not-allowed'
                  : 'text-zinc-600 hover:bg-zinc-100'
              )}
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
