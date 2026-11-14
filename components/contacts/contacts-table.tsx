'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState, useTransition } from 'react'
import { Search, ChevronLeft, ChevronRight, User, Shield } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ContactCompanyLine, ContactListItem } from '@/lib/types'
import { SegmentedFilter } from '@/components/lists/segmented-filter'
import { AmountCell } from '@/components/lists/amount-cell'
import { EntityChip, StatusChip } from '@/components/lists/chips'
import { useAmountOverrides, type AmountOverride } from '@/components/lists/use-amount-overrides'
import { isAmountLocked } from '@/lib/crm-lists/amounts'
import { ACCOUNT_STATUS_CHOICES, KIND_CHOICES, TYPE_CHOICES, TYPE_NOT_SET, type ContactFilters } from '@/lib/crm-lists/filters'

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
  filters: ContactFilters
  linkCounts: { all: number; with: number; none: number }
  currentPage: number
  totalPages: number
  totalCount: number
}

type FilterKey = 'q' | 'status' | 'link' | 'cstatus' | 'kind' | 'ctype'

// The person's own columns, then ONE block holding one line per company (company | 1st Inst | 2nd Inst | Setup fee).
const OUTER = 'md:grid-cols-[minmax(130px,.8fr)_150px_80px_64px_minmax(0,1fr)]'
const INNER = 'grid grid-cols-1 md:grid-cols-[minmax(260px,1.4fr)_160px_160px_130px] gap-1 md:gap-3'

function lineAmount(line: ContactCompanyLine, o: AmountOverride | undefined, key: 'installment_1_amount' | 'installment_2_amount' | 'setup_fee_amount'): number | null {
  return o && key in o ? (o[key] ?? null) : line[key]
}

export function ContactsTable({ items, query, statusFilter, filters, linkCounts, currentPage, totalPages, totalCount }: ContactsTableProps) {
  const router = useRouter()
  const [search, setSearch] = useState(query)
  const [isPending, startTransition] = useTransition()
  const { overrides, apply } = useAmountOverrides(items)
  // The filter values we've actually told the server about — updated
  // synchronously the instant we act, NOT after the async navigation
  // resolves, covering EVERY filter (not just search — a fast, DIFFERENT
  // filter fired before a prior one resolves would otherwise silently drop
  // it, since it would fall back to a still-stale prop). See
  // leads-table.tsx for the full detail (found by adversarial review,
  // 2026-09-02/03).
  const lastFiltersRef = useRef<Record<FilterKey, string>>({
    q: query,
    status: statusFilter,
    link: filters.link,
    cstatus: filters.cstatus,
    kind: filters.kind,
    ctype: filters.ctype,
  })

  // Resync when the URL changed for a reason OTHER than our own action —
  // browser back/forward, or a link elsewhere setting these params. See
  // leads-table.tsx for why this is guarded on the ref, not a plain
  // "prop changed" check.
  useEffect(() => {
    const last = lastFiltersRef.current
    if (
      query !== last.q ||
      statusFilter !== last.status ||
      filters.link !== last.link ||
      filters.cstatus !== last.cstatus ||
      filters.kind !== last.kind ||
      filters.ctype !== last.ctype
    ) {
      lastFiltersRef.current = { q: query, status: statusFilter, link: filters.link, cstatus: filters.cstatus, kind: filters.kind, ctype: filters.ctype }
      setSearch(query)
    }
  }, [query, statusFilter, filters.link, filters.cstatus, filters.kind, filters.ctype])

  function buildParams(overrideParams: Partial<Record<FilterKey | 'page', string>> = {}) {
    const params = new URLSearchParams()
    const cur = lastFiltersRef.current
    const pick = (k: FilterKey) => overrideParams[k] ?? cur[k]
    if (pick('q')) params.set('q', pick('q'))
    if (pick('status') && pick('status') !== 'active') params.set('status', pick('status'))
    if (pick('link')) params.set('link', pick('link'))
    if (pick('cstatus')) params.set('cstatus', pick('cstatus'))
    if (pick('kind')) params.set('kind', pick('kind'))
    if (pick('ctype')) params.set('ctype', pick('ctype'))
    const p = overrideParams.page ?? ''
    if (p && p !== '1') params.set('page', p)
    return params.toString()
  }

  function updateFilter(key: FilterKey, value: string) {
    lastFiltersRef.current = { ...lastFiltersRef.current, [key]: value }
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

  const linkOptions = [
    { value: '', label: 'All', count: linkCounts.all },
    { value: 'with', label: 'With a company', count: linkCounts.with },
    { value: 'none', label: 'No company', count: linkCounts.none },
  ]
  const statusOptions = [
    { value: '', label: 'All' },
    ...ACCOUNT_STATUS_CHOICES.map(s => ({ value: s, label: s })),
  ]
  const kindOptions = [
    { value: '', label: 'All' },
    ...KIND_CHOICES.map(k => ({ value: k, label: k === 'One-Time' ? 'One-time' : k })),
  ]
  const typeOptions = [
    { value: '', label: 'All' },
    ...TYPE_CHOICES.map(t => ({ value: t.value, label: t.label })),
    { value: TYPE_NOT_SET, label: 'Not set' },
  ]

  return (
    <div className="space-y-4">
      {/* Filters */}
      <form onSubmit={handleSearch} className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <input
          type="text"
          value={search}
          onChange={handleSearchChange}
          placeholder="Search name or email..."
          className="w-full pl-9 pr-4 py-2 rounded-lg border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </form>
      <div className="flex flex-wrap gap-x-6 gap-y-3">
        <SegmentedFilter label="Companies" options={linkOptions} value={filters.link} onChange={v => updateFilter('link', v)} disabled={isPending} />
        <SegmentedFilter label="Company status" options={statusOptions} value={filters.cstatus} onChange={v => updateFilter('cstatus', v)} disabled={isPending} />
        <SegmentedFilter label="Client kind" options={kindOptions} value={filters.kind} onChange={v => updateFilter('kind', v)} disabled={isPending} />
        <SegmentedFilter label="Company type" options={typeOptions} value={filters.ctype} onChange={v => updateFilter('ctype', v)} disabled={isPending} />
      </div>

      {/* Stats row */}
      <div className="flex gap-3 flex-wrap text-sm">
        <span className="px-3 py-1 rounded-full bg-zinc-100 text-zinc-700 font-medium">
          {totalCount} total
        </span>
      </div>

      {/* Table */}
      <div className="bg-white rounded-lg border overflow-x-auto">
        <div className={cn('min-w-[1260px] transition-opacity', isPending && 'opacity-50')}>
          {/* Header */}
          <div className={cn('hidden md:grid gap-3 px-4 py-2.5 border-b bg-zinc-50 text-xs font-medium text-muted-foreground uppercase tracking-wider', OUTER)}>
            <span>Name</span>
            <span>Email</span>
            <span>Citizenship</span>
            <span>Tier</span>
            <div className={INNER}>
              <span>Companies</span>
              <span>1st Inst</span>
              <span>2nd Inst</span>
              <span>Setup fee</span>
            </div>
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
                onClick={e => {
                  if ((e.target as HTMLElement).closest('[data-no-nav]')) return
                  router.push(`/contacts/${item.id}`)
                }}
                role="button"
                tabIndex={0}
                onKeyDown={e => e.target === e.currentTarget && e.key === 'Enter' && router.push(`/contacts/${item.id}`)}
                className={cn('grid grid-cols-1 gap-1 md:gap-3 px-4 py-3 border-b last:border-b-0 hover:bg-zinc-50 transition-colors items-start cursor-pointer', OUTER)}
              >
                {/* Name */}
                <div className="flex items-center gap-2 min-w-0 pt-0.5">
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
                <div className="hidden md:block text-xs text-muted-foreground truncate pt-1">
                  {item.email ?? '—'}
                </div>

                {/* Citizenship */}
                <div className="hidden md:block text-xs text-muted-foreground pt-1">
                  {item.citizenship ?? '—'}
                </div>

                {/* Tier */}
                <div className="hidden md:block pt-0.5">
                  {item.portal_tier && (
                    <span className={cn('text-xs font-medium px-1.5 py-0.5 rounded', TIER_COLORS[item.portal_tier] ?? 'bg-zinc-100')}>
                      {item.portal_tier}
                    </span>
                  )}
                </div>

                {/* Companies: one line per company, each with its own amounts */}
                <div className="min-w-0">
                  {item.companies.length === 0 ? (
                    <span className="text-xs text-muted-foreground">No company</span>
                  ) : (
                    item.companies.map((line, i) => {
                      const o = overrides[line.account_id]
                      const locked = isAmountLocked(line.status)
                      const updatedAt = o?.updated_at ?? line.updated_at
                      return (
                        <div
                          key={line.account_id}
                          className={cn(INNER, 'items-center min-h-[28px]', i > 0 && 'mt-1.5 pt-1.5 border-t border-dashed', locked && 'opacity-60')}
                        >
                          <div className="flex min-w-0 items-center gap-1.5">
                            <Link
                              href={`/accounts/${line.account_id}`}
                              data-no-nav
                              className="truncate text-sm font-medium hover:underline"
                            >
                              {line.company_name}
                            </Link>
                            <EntityChip entityType={line.entity_type} />
                            <StatusChip status={line.status} />
                          </div>
                          <AmountCell
                            accountId={line.account_id}
                            field="installment_1_amount"
                            amount={lineAmount(line, o, 'installment_1_amount')}
                            currency={line.installment_1_currency}
                            locked={locked}
                            updatedAt={updatedAt}
                            chip={line.chip_1}
                            onSaved={apply}
                          />
                          <AmountCell
                            accountId={line.account_id}
                            field="installment_2_amount"
                            amount={lineAmount(line, o, 'installment_2_amount')}
                            currency={line.installment_2_currency}
                            locked={locked}
                            updatedAt={updatedAt}
                            chip={line.chip_2}
                            onSaved={apply}
                          />
                          <AmountCell
                            accountId={line.account_id}
                            field="setup_fee_amount"
                            amount={lineAmount(line, o, 'setup_fee_amount')}
                            currency={line.setup_fee_currency}
                            locked={locked}
                            updatedAt={updatedAt}
                            emptyLabel="—"
                            onSaved={apply}
                          />
                        </div>
                      )
                    })
                  )}
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
    </div>
  )
}
