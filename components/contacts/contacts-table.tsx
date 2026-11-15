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
import { ColumnsMenu } from '@/components/lists/columns-menu'
import { LetterBar } from '@/components/lists/letter-bar'
import { LISTS_CONTAINER, ListStyles } from '@/components/lists/list-styles'
import { YearSelect } from '@/components/lists/year-select'
import { ListHoverCard } from '@/components/lists/hover-card'
import { MessageContactButton } from '@/components/contacts/message-contact-button'
import { useAmountOverrides, type AmountOverride } from '@/components/lists/use-amount-overrides'
import { isAmountLocked } from '@/lib/crm-lists/amounts'
import { chosenColumns, gridMinWidth, gridTemplate, hasColumn } from '@/lib/crm-lists/columns'
import { contactCellText, contactMetaText } from '@/lib/crm-lists/cells'
import { companyCard, personCard } from '@/lib/crm-lists/hover-cards'
import { ACCOUNT_STATUS_CHOICES, KIND_CHOICES, TYPE_CHOICES, TYPE_NOT_SET, type ContactFilters } from '@/lib/crm-lists/filters'

const TIER_COLORS: Record<string, string> = {
  'lead': 'bg-zinc-100 text-zinc-600',
  'formation': 'bg-violet-100 text-violet-700',
  'onboarding': 'bg-amber-100 text-amber-700',
  'active': 'bg-emerald-100 text-emerald-700',
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
  /** The extra fields this person chose. */
  columns: string[]
  letter: string
  letters: { all: number; byLetter: Record<string, number> }
  year: number
  years: number[]
  defaultYear: number
}

type FilterKey = 'q' | 'status' | 'link' | 'cstatus' | 'kind' | 'ctype' | 'letter' | 'year'

// Wide (the table has the room the chosen fields need): one row = the person, the chosen fields as columns, then ONE block holding a
// line per company (company | 1st Inst | 2nd Inst | Setup fee). Narrower: the person (the chosen fields on one small line under the
// name) and the companies block; on a phone everything stacks. The wide columns come from --cols (built from the chosen fields).
const MID_COLS = 'md:grid-cols-[minmax(200px,280px)_minmax(0,1fr)] md:gap-2.5 lc-row'
const ROW_GRID = `grid grid-cols-1 gap-1 ${MID_COLS}`
const HEAD_GRID = `hidden md:grid ${MID_COLS}`
const INNER = 'grid grid-cols-2 gap-x-3 gap-y-1 md:grid-cols-[minmax(0,1.5fr)_minmax(112px,1fr)_minmax(112px,1fr)_minmax(84px,.6fr)]'

function lineAmount(line: ContactCompanyLine, o: AmountOverride | undefined, key: 'installment_1_amount' | 'installment_2_amount' | 'setup_fee_amount'): number | null {
  return o && key in o ? (o[key] ?? null) : line[key]
}

/** A small label shown above an amount on a phone, where the column headers are gone. */
function PhoneLabel({ children }: { children: React.ReactNode }) {
  return <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground md:hidden">{children}</span>
}

export function ContactsTable({ items, query, statusFilter, filters, linkCounts, currentPage, totalPages, totalCount, columns, letter, letters, year, years, defaultYear }: ContactsTableProps) {
  const router = useRouter()
  const [search, setSearch] = useState(query)
  const [isPending, startTransition] = useTransition()
  const { overrides, apply } = useAmountOverrides(items)
  const yearParam = year === defaultYear ? '' : String(year)
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
    letter,
    year: yearParam,
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
      filters.ctype !== last.ctype ||
      letter !== last.letter ||
      yearParam !== last.year
    ) {
      lastFiltersRef.current = { q: query, status: statusFilter, link: filters.link, cstatus: filters.cstatus, kind: filters.kind, ctype: filters.ctype, letter, year: yearParam }
      setSearch(query)
    }
  }, [query, statusFilter, filters.link, filters.cstatus, filters.kind, filters.ctype, letter, yearParam])

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
    if (pick('letter')) params.set('letter', pick('letter'))
    if (pick('year')) params.set('year', pick('year'))
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

  const { before: extraCols } = chosenColumns('contacts', columns)
  const showCompanyStatus = hasColumn(columns, 'company_status')
  const rowVars = { '--cols': gridTemplate('contacts', columns) } as React.CSSProperties
  const first = `1st Inst · ${year}`
  const second = `2nd Inst · ${year}`

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <form onSubmit={handleSearch} className="relative w-full max-w-md flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={handleSearchChange}
            placeholder="Search name or email..."
            className="w-full pl-9 pr-4 py-2 rounded-lg border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </form>
        <div className="ml-auto">
          <ColumnsMenu list="contacts" selected={columns} always="Name, Companies, 1st Inst, 2nd Inst, Setup fee" />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <SegmentedFilter label="Companies" options={linkOptions} value={filters.link} onChange={v => updateFilter('link', v)} disabled={isPending} />
        <SegmentedFilter label="Company status" options={statusOptions} value={filters.cstatus} onChange={v => updateFilter('cstatus', v)} disabled={isPending} />
        <SegmentedFilter label="Client kind" options={kindOptions} value={filters.kind} onChange={v => updateFilter('kind', v)} disabled={isPending} />
        <SegmentedFilter label="Company type" options={typeOptions} value={filters.ctype} onChange={v => updateFilter('ctype', v)} disabled={isPending} />
        <YearSelect year={year} years={years} onChange={y => updateFilter('year', y === defaultYear ? '' : String(y))} disabled={isPending} />
      </div>
      <LetterBar value={letter} counts={letters} onChange={l => updateFilter('letter', l)} disabled={isPending} />

      {/* Stats row */}
      <div className="flex gap-3 flex-wrap text-sm">
        <span className="px-3 py-1 rounded-full bg-zinc-100 text-zinc-700 font-medium">
          {totalCount} total
        </span>
      </div>

      {/* Table */}
      <div className="bg-white rounded-lg border overflow-x-auto" style={LISTS_CONTAINER}>
        <ListStyles minWidth={gridMinWidth('contacts', columns)} />
        <div className={cn('transition-opacity', isPending && 'opacity-50')} style={rowVars}>
          {/* Header (wide and medium windows) */}
          <div className={cn(HEAD_GRID, 'px-4 py-2.5 border-b bg-zinc-50 text-xs font-medium text-muted-foreground uppercase tracking-wider')}>
            <span>Name</span>
            {extraCols.map(c => (
              <span key={c.id} className="lc-x">{c.short ?? c.label}</span>
            ))}
            <div className={INNER}>
              <span>Companies</span>
              <span>{first}</span>
              <span>{second}</span>
              <span>Setup fee</span>
            </div>
          </div>

          {/* Rows */}
          {items.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              {letter ? 'No contact starts with that letter under the filters you have on.' : 'No contacts found'}
            </div>
          ) : (
            items.map(item => {
              const meta = extraCols.map(c => contactMetaText(item, c.id)).filter((x): x is string => !!x)
              return (
                <div
                  key={item.id}
                  onClick={e => {
                    if ((e.target as HTMLElement).closest('[data-no-nav]')) return
                    router.push(`/contacts/${item.id}`)
                  }}
                  role="button"
                  tabIndex={0}
                  onKeyDown={e => e.target === e.currentTarget && e.key === 'Enter' && router.push(`/contacts/${item.id}`)}
                  className={cn('px-4 py-3 border-b last:border-b-0 hover:bg-zinc-50 transition-colors items-start cursor-pointer', ROW_GRID)}
                >
                  {/* Name (and, on a window too narrow for columns, the chosen fields on one small line) */}
                  <div className="flex items-start gap-2 min-w-0 pt-0.5">
                    <User className="mt-0.5 h-4 w-4 text-muted-foreground shrink-0" />
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <ListHoverCard
                          card={personCard({ ...item, companies: item.companies.map(c => ({ company_name: c.company_name, status: c.status })) })}
                          className="min-w-0 max-w-full"
                        >
                          <p className="truncate font-medium text-sm">{item.full_name}</p>
                        </ListHoverCard>
                        {/* Write a portal chat message from here (Antonio 2026-11-15: "directly from the list"). */}
                        <MessageContactButton contactId={item.id} contactName={item.full_name || ''} variant="icon" />
                      </div>
                      <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                        {item.language && !hasColumn(columns, 'language') && <span>{item.language}</span>}
                        {item.passport_on_file && (
                          <span className="flex items-center gap-0.5 text-emerald-600">
                            <Shield className="h-3 w-3" />
                            ID
                          </span>
                        )}
                        {item.itin_on_file && (
                          <span className="text-indigo-600">ITIN</span>
                        )}
                      </div>
                      {meta.length > 0 && <p className="lc-m mt-0.5 text-xs text-muted-foreground">{meta.join(' · ')}</p>}
                    </div>
                  </div>

                  {/* The chosen fields, as columns (wide window) */}
                  {extraCols.map(c => {
                    const text = contactCellText(item, c.id)
                    if (c.id === 'portal_stage') {
                      return (
                        <div key={c.id} className="lc-x pt-0.5">
                          {text ? (
                            <span className={cn('text-xs font-medium px-1.5 py-0.5 rounded', TIER_COLORS[text] ?? 'bg-zinc-100 text-zinc-600')}>{text}</span>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </div>
                      )
                    }
                    return (
                      <div key={c.id} className="lc-x min-w-0 truncate pt-1 text-xs text-muted-foreground">
                        {text ?? '—'}
                      </div>
                    )
                  })}

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
                            className={cn(INNER, 'items-start min-h-[28px]', i > 0 && 'mt-1.5 pt-1.5 border-t border-dashed', locked && 'opacity-60')}
                          >
                            <div className="col-span-2 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 md:col-span-1">
                              <ListHoverCard card={companyCard(line, year)}>
                                <Link
                                  href={`/accounts/${line.account_id}`}
                                  data-no-nav
                                  className="break-words text-sm font-medium hover:underline"
                                >
                                  {line.company_name}
                                </Link>
                              </ListHoverCard>
                              <EntityChip entityType={line.entity_type} />
                              {/* Its status is a field you can tick; a locked company always says why it is greyed. */}
                              {(showCompanyStatus || locked) && <StatusChip status={line.status} />}
                            </div>
                            <div className="min-w-0">
                              <PhoneLabel>{first}</PhoneLabel>
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
                            </div>
                            <div className="min-w-0">
                              <PhoneLabel>{second}</PhoneLabel>
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
                            </div>
                            <div className="min-w-0">
                              <PhoneLabel>Setup fee</PhoneLabel>
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
                          </div>
                        )
                      })
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
    </div>
  )
}
