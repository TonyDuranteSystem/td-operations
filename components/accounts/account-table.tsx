'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState, useTransition } from 'react'
import { Search, AlertCircle, ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { AccountListItem } from '@/lib/types'
import { CreateAccountDialog } from './create-account-dialog'
import { SegmentedFilter } from '@/components/lists/segmented-filter'
import { AmountCell } from '@/components/lists/amount-cell'
import { EntityChip, KindChip, StatusChip } from '@/components/lists/chips'
import { useAmountOverrides } from '@/components/lists/use-amount-overrides'
import { isAmountLocked, perYearLabel, perYearTotal } from '@/lib/crm-lists/amounts'
import { ACCOUNT_STATUS_CHOICES, KIND_CHOICES, TYPE_CHOICES, TYPE_NOT_SET, type AccountFacets } from '@/lib/crm-lists/filters'

interface AccountTableProps {
  items: AccountListItem[]
  query: string
  statusFilter: string
  kindFilter: string
  typeFilter: string
  facets: AccountFacets
  stats: {
    total: number
    withOverdue: number
  }
  currentPage: number
  totalPages: number
  totalCount: number
}

const GRID = 'md:grid-cols-[minmax(220px,1fr)_110px_62px_100px_168px_160px_90px_80px]'

export function AccountTable({ items, query, statusFilter, kindFilter, typeFilter, facets, stats, currentPage, totalPages, totalCount }: AccountTableProps) {
  const router = useRouter()
  const [search, setSearch] = useState(query)
  const [isPending, startTransition] = useTransition()
  const [showCreate, setShowCreate] = useState(false)
  const { overrides, apply } = useAmountOverrides(items)
  // The filter values we've actually told the server about — updated
  // synchronously the instant we act, NOT after the async navigation
  // resolves. Covers EVERY filter, not just search: this page has several
  // other filters (status, kind, type) — firing one then another before the
  // first navigation resolves used to silently drop the first one, because
  // the second call fell back to a still-stale prop for it. Found by
  // adversarial review, 2026-09-03 (round 3 — the original round-2 fix only
  // covered search).
  const lastFiltersRef = useRef({ q: query, status: statusFilter, kind: kindFilter, type: typeFilter })

  // Resync when the URL changed for a reason OTHER than our own action —
  // browser back/forward, or a link elsewhere setting these params. See
  // leads-table.tsx for why this is guarded on the ref, not a plain
  // "prop changed" check.
  useEffect(() => {
    const last = lastFiltersRef.current
    if (query !== last.q || statusFilter !== last.status || kindFilter !== last.kind || typeFilter !== last.type) {
      lastFiltersRef.current = { q: query, status: statusFilter, kind: kindFilter, type: typeFilter }
      setSearch(query)
    }
  }, [query, statusFilter, kindFilter, typeFilter])

  function buildParams(overridesParams: Record<string, string> = {}) {
    const params = new URLSearchParams()
    const q = overridesParams.q ?? lastFiltersRef.current.q
    const s = overridesParams.status ?? lastFiltersRef.current.status
    const k = overridesParams.kind ?? lastFiltersRef.current.kind
    const t = overridesParams.type ?? lastFiltersRef.current.type
    const p = overridesParams.page ?? ''
    if (q) params.set('q', q)
    if (s) params.set('status', s)
    if (k) params.set('kind', k)
    if (t) params.set('type', t)
    if (p && p !== '1') params.set('page', p)
    return params.toString()
  }

  function updateFilter(key: 'q' | 'status' | 'kind' | 'type', value: string) {
    lastFiltersRef.current = { ...lastFiltersRef.current, [key]: value }
    startTransition(() => {
      router.push(`/accounts?${buildParams({ [key]: value, page: '1' })}`)
    })
  }

  function goToPage(page: number) {
    startTransition(() => {
      router.push(`/accounts?${buildParams({ page: String(page) })}`)
    })
  }

  function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    updateFilter('q', search)
  }

  // Typing only searches on submit (below), but CLEARING the box must reset
  // immediately — otherwise backspacing to empty, or a phone keyboard's own
  // clear control, leaves the list stuck on the last search with no visible
  // way to get back to the full list (same defect found on Leads, 2026-09-02).
  function handleSearchChange(e: React.ChangeEvent<HTMLInputElement>) {
    const value = e.target.value
    setSearch(value)
    if (value === '' && lastFiltersRef.current.q !== '') {
      updateFilter('q', '')
    }
  }

  const statusOptions = [
    ...ACCOUNT_STATUS_CHOICES.map(s => ({ value: s, label: s, count: facets.status[s] })),
    { value: 'all', label: 'All', count: facets.status.all },
  ]
  const kindOptions = [
    { value: '', label: 'All', count: facets.kind.all },
    ...KIND_CHOICES.map(k => ({ value: k, label: k === 'One-Time' ? 'One-time' : k, count: facets.kind[k] })),
  ]
  const typeOptions = [
    { value: '', label: 'All', count: facets.type.all },
    ...TYPE_CHOICES.map(t => ({ value: t.value, label: t.label, count: facets.type[t.value] })),
    { value: TYPE_NOT_SET, label: 'Not set', count: facets.type[TYPE_NOT_SET] },
  ]

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <form onSubmit={handleSearch} className="flex-1 relative max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={handleSearchChange}
            placeholder="Search company..."
            className="w-full pl-9 pr-4 py-2 rounded-lg border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </form>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-zinc-900 text-white text-sm font-medium hover:bg-zinc-800 transition-colors shrink-0 sm:ml-auto"
        >
          <Plus className="h-4 w-4" />
          New Account
        </button>
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-3">
        <SegmentedFilter label="Status" options={statusOptions} value={statusFilter} onChange={v => updateFilter('status', v)} disabled={isPending} />
        <SegmentedFilter label="Client kind" options={kindOptions} value={kindFilter} onChange={v => updateFilter('kind', v)} disabled={isPending} />
        <SegmentedFilter label="Company type" options={typeOptions} value={typeFilter} onChange={v => updateFilter('type', v)} disabled={isPending} />
      </div>

      {/* Stats row */}
      <div className="flex gap-3 flex-wrap text-sm">
        <span className="px-3 py-1 rounded-full bg-zinc-100 text-zinc-700 font-medium">
          {stats.total} total
        </span>
        {stats.withOverdue > 0 && (
          <span className="px-3 py-1 rounded-full bg-red-100 text-red-700 font-medium flex items-center gap-1">
            <AlertCircle className="h-3.5 w-3.5" />
            {stats.withOverdue} with overdue payments
          </span>
        )}
      </div>

      {/* Table */}
      <div className="bg-white rounded-lg border overflow-x-auto">
        <div className={cn('min-w-[1110px] transition-opacity', isPending && 'opacity-50')}>
          {/* Header */}
          <div className={cn('hidden md:grid gap-3 px-4 py-2.5 border-b bg-zinc-50 text-xs font-medium text-muted-foreground uppercase tracking-wider', GRID)}>
            <span>Company</span>
            <span>Contact</span>
            <span>Type</span>
            <span>Status</span>
            <span>1st Inst</span>
            <span>2nd Inst</span>
            <span>Per year</span>
            <span className="text-right">Overdue</span>
          </div>

          {/* Rows */}
          {items.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              No companies found
            </div>
          ) : (
            items.map(item => {
              const o = overrides[item.id]
              const first = o && 'installment_1_amount' in o ? (o.installment_1_amount ?? null) : item.installment_1_amount
              const second = o && 'installment_2_amount' in o ? (o.installment_2_amount ?? null) : item.installment_2_amount
              const updatedAt = o?.updated_at ?? item.updated_at
              const locked = isAmountLocked(item.status)
              const total = perYearTotal(
                { amount: first, currency: item.installment_1_currency },
                { amount: second, currency: item.installment_2_currency },
              )
              return (
                <div
                  key={item.id}
                  onClick={e => {
                    if ((e.target as HTMLElement).closest('[data-no-nav]')) return
                    router.push(`/accounts/${item.id}`)
                  }}
                  className={cn(
                    'grid grid-cols-1 gap-1 md:gap-3 px-4 py-3 border-b last:border-b-0 hover:bg-zinc-50 transition-colors items-center cursor-pointer',
                    GRID,
                    locked && 'opacity-60',
                  )}
                >
                  {/* Company */}
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 font-medium text-sm truncate">
                      <Link href={`/accounts/${item.id}`} className="truncate hover:underline" onClick={e => e.stopPropagation()}>
                        {item.company_name}
                      </Link>
                      <KindChip kind={item.account_type} />
                    </p>
                    {item.state_of_formation && (
                      <p className="text-xs text-muted-foreground">{item.state_of_formation}</p>
                    )}
                  </div>

                  {/* Contact */}
                  <div className="text-xs text-muted-foreground truncate hidden md:block">
                    {item.contact_name ?? '—'}
                  </div>

                  {/* Company type */}
                  <div className="hidden md:block">
                    <EntityChip entityType={item.entity_type} />
                  </div>

                  {/* Status */}
                  <div className="hidden md:block">
                    <StatusChip status={item.status} />
                  </div>

                  {/* 1st Inst */}
                  <div className="hidden md:block">
                    <AmountCell
                      accountId={item.id}
                      field="installment_1_amount"
                      amount={first}
                      currency={item.installment_1_currency}
                      locked={locked}
                      updatedAt={updatedAt}
                      chip={item.chip_1}
                      onSaved={apply}
                    />
                  </div>

                  {/* 2nd Inst */}
                  <div className="hidden md:block">
                    <AmountCell
                      accountId={item.id}
                      field="installment_2_amount"
                      amount={second}
                      currency={item.installment_2_currency}
                      locked={locked}
                      updatedAt={updatedAt}
                      chip={item.chip_2}
                      onSaved={apply}
                    />
                  </div>

                  {/* Per year: added up on screen, never typed */}
                  <div className="hidden md:block text-sm font-semibold tabular-nums">
                    {total.kind === 'none' ? <span className="text-muted-foreground font-normal">—</span> : perYearLabel(total)}
                  </div>

                  {/* Overdue */}
                  <div className="hidden md:flex justify-end">
                    {item.payment_overdue > 0 && (
                      <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-red-100 text-red-700">
                        {item.payment_overdue}
                      </span>
                    )}
                  </div>
                </div>
              )
            })
          )}
        </div>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between pt-2">
          <p className="text-xs text-muted-foreground">
            {((currentPage - 1) * 50) + 1}–{Math.min(currentPage * 50, totalCount)} of {totalCount} · 50 per page
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

      <CreateAccountDialog open={showCreate} onClose={() => setShowCreate(false)} />
    </div>
  )
}
