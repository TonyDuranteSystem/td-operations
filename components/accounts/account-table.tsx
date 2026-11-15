'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState, useTransition } from 'react'
import { AlertCircle, ChevronLeft, ChevronRight, Plus, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { AccountListItem } from '@/lib/types'
import { CreateAccountDialog } from './create-account-dialog'
import { SegmentedFilter } from '@/components/lists/segmented-filter'
import { AmountCell } from '@/components/lists/amount-cell'
import { EntityChip, KindChip, StatusChip } from '@/components/lists/chips'
import { ColumnsMenu } from '@/components/lists/columns-menu'
import { LetterBar } from '@/components/lists/letter-bar'
import { LISTS_CONTAINER, ListStyles } from '@/components/lists/list-styles'
import { YearSelect } from '@/components/lists/year-select'
import { ListHoverCard } from '@/components/lists/hover-card'
import { ListSearchBox } from '@/components/lists/list-search-box'
import { FastTooltip } from '@/components/ui/fast-tooltip'
import { OpenInWindowLink } from '@/components/windows/open-in-window-link'
import { useAmountOverrides } from '@/components/lists/use-amount-overrides'
import { isAmountLocked, perYearLabel, perYearTotal } from '@/lib/crm-lists/amounts'
import { chosenColumns, gridMinWidth, gridTemplate, hasColumn } from '@/lib/crm-lists/columns'
import { accountCellText, accountMetaText } from '@/lib/crm-lists/cells'
import { companyCard, personCard } from '@/lib/crm-lists/hover-cards'
import { ACCOUNT_STATUS_CHOICES, KIND_CHOICES, TYPE_CHOICES, TYPE_NOT_SET, type AccountFacets } from '@/lib/crm-lists/filters'

interface AccountTableProps {
  items: AccountListItem[]
  query: string
  statusFilter: string
  kindFilter: string
  typeFilter: string
  /** Only companies with an overdue invoice (the "with overdue payments" pill was clicked). */
  overdueOnly: boolean
  facets: AccountFacets
  stats: {
    total: number
    withOverdue: number
  }
  currentPage: number
  totalPages: number
  totalCount: number
  /** The extra fields this person chose. */
  columns: string[]
  letter: string
  letters: { all: number; byLetter: Record<string, number> }
  year: number
  years: number[]
  defaultYear: number
}

type FilterKey = 'q' | 'status' | 'kind' | 'type' | 'overdue' | 'letter' | 'year'

// Wide (the table has the room the chosen fields need): company, the chosen fields, 1st Inst, 2nd Inst, Per year, then any "after" field
// (Overdue) — the columns come from --cols. Narrower: company (chosen fields on one small line under it) + the three money columns.
// Phone: the company, then its three money values side by side with labels.
const MID_COLS = 'md:grid-cols-[minmax(0,1fr)_130px_130px_84px] md:gap-2.5 lc-row'
const ROW_GRID = `grid grid-cols-3 gap-x-3 gap-y-1 ${MID_COLS}`
const HEAD_GRID = `hidden md:grid ${MID_COLS}`

export function AccountTable({ items, query, statusFilter, kindFilter, typeFilter, overdueOnly, facets, stats, currentPage, totalPages, totalCount, columns, letter, letters, year, years, defaultYear }: AccountTableProps) {
  const router = useRouter()
  const [search, setSearch] = useState(query)
  const [isPending, startTransition] = useTransition()
  const [showCreate, setShowCreate] = useState(false)
  const { overrides, apply } = useAmountOverrides(items)
  const yearParam = year === defaultYear ? '' : String(year)
  // The filter values we've actually told the server about — updated
  // synchronously the instant we act, NOT after the async navigation
  // resolves. Covers EVERY filter, not just search: this page has several
  // other filters (status, kind, type) — firing one then another before the
  // first navigation resolves used to silently drop the first one, because
  // the second call fell back to a still-stale prop for it. Found by
  // adversarial review, 2026-09-03 (round 3 — the original round-2 fix only
  // covered search).
  const overdueParam = overdueOnly ? '1' : ''
  const lastFiltersRef = useRef<Record<FilterKey, string>>({ q: query, status: statusFilter, kind: kindFilter, type: typeFilter, overdue: overdueParam, letter, year: yearParam })

  // Resync when the URL changed for a reason OTHER than our own action —
  // browser back/forward, or a link elsewhere setting these params. See
  // leads-table.tsx for why this is guarded on the ref, not a plain
  // "prop changed" check.
  useEffect(() => {
    const last = lastFiltersRef.current
    if (query !== last.q || statusFilter !== last.status || kindFilter !== last.kind || typeFilter !== last.type || overdueParam !== last.overdue || letter !== last.letter || yearParam !== last.year) {
      lastFiltersRef.current = { q: query, status: statusFilter, kind: kindFilter, type: typeFilter, overdue: overdueParam, letter, year: yearParam }
      setSearch(query)
    }
  }, [query, statusFilter, kindFilter, typeFilter, overdueParam, letter, yearParam])

  function buildParams(overridesParams: Record<string, string> = {}) {
    const params = new URLSearchParams()
    const cur = lastFiltersRef.current
    const q = overridesParams.q ?? cur.q
    const s = overridesParams.status ?? cur.status
    const k = overridesParams.kind ?? cur.kind
    const t = overridesParams.type ?? cur.type
    const o = overridesParams.overdue ?? cur.overdue
    const l = overridesParams.letter ?? cur.letter
    const y = overridesParams.year ?? cur.year
    const p = overridesParams.page ?? ''
    if (q) params.set('q', q)
    if (s) params.set('status', s)
    if (k) params.set('kind', k)
    if (t) params.set('type', t)
    if (o) params.set('overdue', o)
    if (l) params.set('letter', l)
    if (y) params.set('year', y)
    if (p && p !== '1') params.set('page', p)
    return params.toString()
  }

  function updateFilter(key: FilterKey, value: string) {
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

  const { before, tail } = chosenColumns('accounts', columns)
  const rowVars = { '--cols': gridTemplate('accounts', columns) } as React.CSSProperties
  const first = `1st Inst · ${year}`
  const second = `2nd Inst · ${year}`

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <ListSearchBox kind="account" value={search} onChange={handleSearchChange} onSubmit={handleSearch} placeholder="Search company..." />
        <div className="ml-auto flex items-center gap-2">
          <ColumnsMenu list="accounts" selected={columns} always="Company, 1st Inst, 2nd Inst, Per year" />
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-zinc-900 text-white text-sm font-medium hover:bg-zinc-800 transition-colors shrink-0"
          >
            <Plus className="h-4 w-4" />
            New Account
          </button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <SegmentedFilter label="Status" options={statusOptions} value={statusFilter} onChange={v => updateFilter('status', v)} disabled={isPending} />
        <SegmentedFilter label="Client kind" options={kindOptions} value={kindFilter} onChange={v => updateFilter('kind', v)} disabled={isPending} />
        <SegmentedFilter label="Company type" options={typeOptions} value={typeFilter} onChange={v => updateFilter('type', v)} disabled={isPending} />
        <YearSelect year={year} years={years} onChange={y => updateFilter('year', y === defaultYear ? '' : String(y))} disabled={isPending} />
      </div>
      <LetterBar value={letter} counts={letters} onChange={l => updateFilter('letter', l)} disabled={isPending} />

      {/* Stats row */}
      <div className="flex gap-3 flex-wrap text-sm">
        <span className="px-3 py-1 rounded-full bg-zinc-100 text-zinc-700 font-medium">
          {stats.total} total
        </span>
        {overdueOnly ? (
          // The list is already narrowed to overdue companies (typically inside the floating window): this clears it.
          <FastTooltip label="Show every company again" align="left">
            <button
              type="button"
              onClick={() => updateFilter('overdue', '')}
              disabled={isPending}
              aria-label="Show every company again"
              className="px-3 py-1 rounded-full bg-red-600 text-white font-medium flex items-center gap-1 hover:bg-red-700 transition-colors"
            >
              <AlertCircle className="h-3.5 w-3.5" />
              {stats.withOverdue} with overdue payments
              <X className="h-3.5 w-3.5" />
            </button>
          </FastTooltip>
        ) : (
          stats.withOverdue > 0 && (
            // Opens the same list, limited to the companies with an overdue payment, in a floating window.
            <OpenInWindowLink
              href={`/accounts?${buildParams({ overdue: '1', page: '1' })}`}
              title="Companies with overdue payments"
              className="px-3 py-1 rounded-full bg-red-100 text-red-700 font-medium flex items-center gap-1 hover:bg-red-200 transition-colors cursor-pointer"
            >
              <AlertCircle className="h-3.5 w-3.5" />
              {stats.withOverdue} with overdue payments
            </OpenInWindowLink>
          )
        )}
      </div>

      {/* Table */}
      <div className="bg-white rounded-lg border overflow-x-auto" style={LISTS_CONTAINER}>
        <ListStyles minWidth={gridMinWidth('accounts', columns)} />
        <div className={cn('transition-opacity', isPending && 'opacity-50')} style={rowVars}>
          {/* Header (wide and medium windows) */}
          <div className={cn(HEAD_GRID, 'px-4 py-2.5 border-b bg-zinc-50 text-xs font-medium text-muted-foreground uppercase tracking-wider')}>
            <span>Company</span>
            {before.map(c => (
              <span key={c.id} className="lc-x">{c.short ?? c.label}</span>
            ))}
            <span>{first}</span>
            <span>{second}</span>
            <span>Per year</span>
            {tail.map(c => (
              <span key={c.id} className="lc-x text-right">{c.short ?? c.label}</span>
            ))}
          </div>

          {/* Rows */}
          {items.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              {letter ? 'No company starts with that letter under the filters you have on.' : 'No companies found'}
            </div>
          ) : (
            items.map(item => {
              const o = overrides[item.id]
              const firstAmount = o && 'installment_1_amount' in o ? (o.installment_1_amount ?? null) : item.installment_1_amount
              const secondAmount = o && 'installment_2_amount' in o ? (o.installment_2_amount ?? null) : item.installment_2_amount
              const updatedAt = o?.updated_at ?? item.updated_at
              const locked = isAmountLocked(item.status)
              const total = perYearTotal(
                { amount: firstAmount, currency: item.installment_1_currency },
                { amount: secondAmount, currency: item.installment_2_currency },
              )
              // The chosen fields on one small line under the company name, for a window too narrow to show them as columns.
              const meta = [...before, ...tail]
                .map(c => accountMetaText(item, c.id, c.short ?? c.label))
                .filter((x): x is string => !!x)
              return (
                <div
                  key={item.id}
                  onClick={e => {
                    if ((e.target as HTMLElement).closest('[data-no-nav]')) return
                    router.push(`/accounts/${item.id}`)
                  }}
                  className={cn(
                    'px-4 py-3 border-b last:border-b-0 hover:bg-zinc-50 transition-colors items-start cursor-pointer',
                    ROW_GRID,
                    locked && 'opacity-60',
                  )}
                >
                  {/* Company */}
                  <div className="col-span-3 min-w-0 md:col-span-1">
                    <div className="flex items-center gap-1.5 font-medium text-sm">
                      <ListHoverCard card={companyCard(item, year)} className="min-w-0 max-w-full">
                        <Link href={`/accounts/${item.id}`} className="truncate hover:underline" onClick={e => e.stopPropagation()}>
                          {item.company_name}
                        </Link>
                      </ListHoverCard>
                      {!hasColumn(columns, 'kind') && <KindChip kind={item.account_type} />}
                      {/* A greyed, locked company always says why, even when the Status column is not chosen. */}
                      {locked && !hasColumn(columns, 'status') && <StatusChip status={item.status} />}
                    </div>
                    {meta.length > 0 && <p className="lc-m mt-0.5 text-xs text-muted-foreground">{meta.join(' · ')}</p>}
                  </div>

                  {/* The chosen fields, as columns (wide window) */}
                  {before.map(c => (
                    <div key={c.id} className="lc-x min-w-0 truncate pt-0.5 text-xs text-muted-foreground">
                      {c.id === 'type' ? (
                        <EntityChip entityType={item.entity_type} />
                      ) : c.id === 'status' ? (
                        <StatusChip status={item.status} />
                      ) : c.id === 'contact' && item.contact_card && item.contact_name ? (
                        <ListHoverCard card={personCard(item.contact_card)} className="min-w-0 max-w-full">
                          <span className="truncate">{item.contact_name}</span>
                        </ListHoverCard>
                      ) : (
                        (accountCellText(item, c.id) ?? '—')
                      )}
                    </div>
                  ))}

                  {/* 1st Inst */}
                  <div className="min-w-0">
                    <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground md:hidden">{first}</span>
                    <AmountCell
                      accountId={item.id}
                      field="installment_1_amount"
                      amount={firstAmount}
                      currency={item.installment_1_currency}
                      locked={locked}
                      updatedAt={updatedAt}
                      chip={item.chip_1}
                      onSaved={apply}
                    />
                  </div>

                  {/* 2nd Inst */}
                  <div className="min-w-0">
                    <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground md:hidden">{second}</span>
                    <AmountCell
                      accountId={item.id}
                      field="installment_2_amount"
                      amount={secondAmount}
                      currency={item.installment_2_currency}
                      locked={locked}
                      updatedAt={updatedAt}
                      chip={item.chip_2}
                      onSaved={apply}
                    />
                  </div>

                  {/* Per year: added up on screen, never typed */}
                  <div className="min-w-0 text-sm font-semibold tabular-nums">
                    <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground md:hidden">Per year</span>
                    {total.kind === 'none' ? <span className="text-muted-foreground font-normal">—</span> : perYearLabel(total)}
                  </div>

                  {/* Fields placed after the money (Overdue) */}
                  {tail.map(c => (
                    <div key={c.id} className="lc-xf justify-end">
                      {c.id === 'overdue' ? (
                        item.payment_overdue > 0 ? (
                          <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-red-100 text-red-700">{item.payment_overdue}</span>
                        ) : null
                      ) : (
                        <span className="text-xs text-muted-foreground">{accountCellText(item, c.id) ?? '—'}</span>
                      )}
                    </div>
                  ))}
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
