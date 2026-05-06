'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronLeft, ChevronRight, Building2, AlertTriangle, CheckCircle2, Lock, ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils'
import { parseISO, differenceInCalendarDays } from 'date-fns'
import { MarkFiledDialog } from '@/components/calendar/mark-filed-dialog'
import type { CalendarRow, RenewalRow, InfoRow } from '@/app/(dashboard)/calendar/page'

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

interface AnnualCalendarProps {
  rows: CalendarRow[]
  year: number
  today: string
}

// Urgency = days until deadline, used for color
type Urgency = 'overdue' | 'red' | 'amber' | 'gray' | 'green'

function urgencyFor(row: CalendarRow, today: string): Urgency {
  if (row.kind === 'ra' || row.kind === 'ar') {
    const r = row as RenewalRow
    if (r.status === 'filed') return 'green'
    if (r.status === 'offboarding') return 'gray'
    const days = differenceInCalendarDays(parseISO(r.due_date), parseISO(today))
    if (days < 0) return 'overdue'
    if (days <= 30) return 'red'
    if (days <= 90) return 'amber'
    return 'gray'
  }
  // tax/payment — simple status-based
  const s = (row as InfoRow).status?.toLowerCase()
  if (s === 'overdue') return 'overdue'
  if (s === 'filed' || s === 'paid' || s === 'completed') return 'green'
  return 'amber'
}

const URGENCY_DOT: Record<Urgency, string> = {
  overdue: 'bg-red-600',
  red: 'bg-red-500',
  amber: 'bg-amber-500',
  gray: 'bg-zinc-400',
  green: 'bg-emerald-500',
}

const KIND_LABEL: Record<CalendarRow['kind'], string> = {
  ra: 'RA Renewal',
  ar: 'Annual Report',
  tax: 'Tax Return',
  payment: 'Payment',
}

const KIND_BADGE: Record<CalendarRow['kind'], string> = {
  ra: 'bg-amber-100 text-amber-800',
  ar: 'bg-purple-100 text-purple-800',
  tax: 'bg-indigo-100 text-indigo-700',
  payment: 'bg-red-100 text-red-700',
}

function isRenewal(row: CalendarRow): row is RenewalRow {
  return row.kind === 'ra' || row.kind === 'ar'
}

export function AnnualCalendar({ rows, year, today }: AnnualCalendarProps) {
  const router = useRouter()
  const [selectedMonth, setSelectedMonth] = useState<number | null>(null)
  const [kindFilter, setKindFilter] = useState<CalendarRow['kind'] | ''>('')
  const [dialogRow, setDialogRow] = useState<RenewalRow | null>(null)

  const filtered = kindFilter ? rows.filter(r => r.kind === kindFilter) : rows

  const monthGroups: CalendarRow[][] = useMemo(() => {
    const groups: CalendarRow[][] = Array.from({ length: 12 }, () => [])
    for (const r of filtered) {
      try {
        const m = parseISO(r.due_date).getMonth()
        groups[m].push(r)
      } catch {
        // skip invalid
      }
    }
    return groups
  }, [filtered])

  const kindCounts: Record<string, number> = {}
  for (const r of rows) kindCounts[r.kind] = (kindCounts[r.kind] ?? 0) + 1

  const todayMonth = parseISO(today).getMonth()
  const todayYear = parseISO(today).getFullYear()

  return (
    <div className="space-y-6">
      {/* Year nav + filters */}
      <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.push(`/calendar?year=${year - 1}`)}
            className="p-1.5 rounded-lg hover:bg-zinc-100"
            aria-label="Previous year"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <span className="font-semibold text-lg">{year}</span>
          <button
            onClick={() => router.push(`/calendar?year=${year + 1}`)}
            className="p-1.5 rounded-lg hover:bg-zinc-100"
            aria-label="Next year"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        </div>

        {/* Kind filter */}
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setKindFilter('')}
            className={cn(
              'text-xs px-2.5 py-1 rounded-full font-medium transition-colors',
              !kindFilter ? 'bg-zinc-900 text-white' : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200',
            )}
          >
            All ({rows.length})
          </button>
          {(['ra', 'ar', 'tax', 'payment'] as const).map(kind => (
            kindCounts[kind] ? (
              <button
                key={kind}
                onClick={() => setKindFilter(kindFilter === kind ? '' : kind)}
                className={cn(
                  'text-xs px-2.5 py-1 rounded-full font-medium transition-colors flex items-center gap-1.5',
                  kindFilter === kind
                    ? 'bg-zinc-900 text-white'
                    : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200',
                )}
              >
                <span className={cn('w-2 h-2 rounded-full', kind === 'ra' ? 'bg-amber-500' : kind === 'ar' ? 'bg-purple-500' : kind === 'tax' ? 'bg-indigo-500' : 'bg-red-500')} />
                {KIND_LABEL[kind]} ({kindCounts[kind]})
              </button>
            ) : null
          ))}
        </div>
      </div>

      {/* 12-month grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        {MONTHS.map((name, i) => {
          const items = monthGroups[i]
          const isPast = year < todayYear || (year === todayYear && i < todayMonth)
          const isCurrent = year === todayYear && i === todayMonth
          const reds = items.filter(r => {
            const u = urgencyFor(r, today)
            return u === 'red' || u === 'overdue'
          }).length

          return (
            <button
              key={i}
              onClick={() => setSelectedMonth(selectedMonth === i ? null : i)}
              className={cn(
                'bg-white rounded-lg border p-3 text-left transition-all hover:shadow-sm',
                selectedMonth === i && 'ring-2 ring-blue-500',
                isCurrent && 'border-blue-300',
                isPast && 'opacity-70',
              )}
            >
              <div className="flex items-center justify-between mb-2">
                <span className={cn('font-semibold text-sm', isCurrent && 'text-blue-600')}>
                  {name}
                </span>
                <div className="flex items-center gap-1">
                  {reds > 0 && (
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-red-100 text-red-700">
                      {reds}
                    </span>
                  )}
                  {items.length > 0 && (
                    <span className="text-xs font-medium px-1.5 py-0.5 rounded-full bg-zinc-100 text-zinc-600">
                      {items.length}
                    </span>
                  )}
                </div>
              </div>

              {/* Status dots */}
              <div className="flex gap-0.5 flex-wrap">
                {items.slice(0, 24).map((item, j) => (
                  <span
                    key={j}
                    className={cn('w-2 h-2 rounded-full', URGENCY_DOT[urgencyFor(item, today)])}
                    title={`${KIND_LABEL[item.kind]}: ${item.company_name}`}
                  />
                ))}
                {items.length > 24 && (
                  <span className="text-xs text-muted-foreground ml-1">+{items.length - 24}</span>
                )}
              </div>
            </button>
          )
        })}
      </div>

      {/* Selected month detail */}
      {selectedMonth !== null && (
        <div className="bg-white rounded-lg border p-5">
          <h3 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground mb-4">
            {MONTHS[selectedMonth]} {year} — {monthGroups[selectedMonth].length} items
          </h3>
          {monthGroups[selectedMonth].length === 0 ? (
            <p className="text-sm text-muted-foreground">No items</p>
          ) : (
            <div className="space-y-1.5">
              {monthGroups[selectedMonth]
                .sort((a, b) => a.due_date.localeCompare(b.due_date))
                .map((row, i) => {
                  const u = urgencyFor(row, today)
                  const renewal = isRenewal(row) ? row : null
                  const actionable = renewal && (u === 'red' || u === 'overdue') && renewal.status !== 'offboarding' && renewal.status !== 'blocked' && renewal.status !== 'filed'
                  const blocked = renewal?.status === 'blocked'
                  const offb = renewal?.status === 'offboarding'

                  return (
                    <div
                      key={i}
                      className={cn(
                        'flex items-center gap-3 py-2 px-2 border rounded-md text-sm transition-colors',
                        actionable && 'border-red-200 bg-red-50/50 hover:bg-red-50 cursor-pointer',
                        blocked && 'border-red-200 bg-red-50',
                        offb && 'opacity-50',
                        u === 'green' && 'opacity-60',
                        !actionable && !blocked && !offb && u !== 'green' && 'border-zinc-200',
                      )}
                      onClick={() => actionable && renewal && setDialogRow(renewal)}
                      role={actionable ? 'button' : undefined}
                      tabIndex={actionable ? 0 : undefined}
                      onKeyDown={(e) => {
                        if (actionable && (e.key === 'Enter' || e.key === ' ') && renewal) {
                          e.preventDefault()
                          setDialogRow(renewal)
                        }
                      }}
                    >
                      <span className={cn('w-2.5 h-2.5 rounded-full shrink-0', URGENCY_DOT[u])} />
                      <span className="text-xs text-muted-foreground min-w-[70px] tabular-nums">
                        {row.due_date.split('-').reverse().join('/')}
                      </span>
                      <span className={cn('text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded shrink-0', KIND_BADGE[row.kind])}>
                        {KIND_LABEL[row.kind]}
                      </span>
                      <span className="font-medium truncate flex-1">{row.company_name}</span>
                      {renewal?.state_of_formation && (
                        <span className="text-xs text-muted-foreground hidden md:inline">
                          {renewal.state_of_formation}
                        </span>
                      )}
                      {renewal?.provider && (
                        <span className="hidden lg:inline-flex items-center gap-1 text-xs text-muted-foreground" title={`Agent: ${renewal.agent_name ?? '—'}\nAddress: ${renewal.ra_address_line ?? '—'}`}>
                          <Building2 className="h-3 w-3" />
                          {renewal.provider}
                        </span>
                      )}
                      {renewal?.drive_folder_url && (
                        <a
                          href={renewal.drive_folder_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="hidden md:inline-flex items-center gap-0.5 text-xs text-blue-600 hover:underline shrink-0"
                          aria-label="Open Drive folder"
                        >
                          Drive <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                      {/* Status badges (right edge) */}
                      {blocked && (
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-red-700 bg-red-100 px-2 py-0.5 rounded-full shrink-0">
                          <Lock className="h-3 w-3" /> Blocked — unpaid
                        </span>
                      )}
                      {offb && (
                        <span className="inline-flex items-center gap-1 text-xs text-zinc-500 bg-zinc-100 px-2 py-0.5 rounded-full shrink-0">
                          Offboarding
                        </span>
                      )}
                      {renewal?.status === 'filed' && (
                        <span className="inline-flex items-center gap-1 text-xs text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-full shrink-0">
                          <CheckCircle2 className="h-3 w-3" /> Filed
                        </span>
                      )}
                      {actionable && (
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-red-700 bg-red-100 px-2 py-0.5 rounded-full shrink-0">
                          <AlertTriangle className="h-3 w-3" /> Mark Filed
                        </span>
                      )}
                      {(row as InfoRow).status && !renewal && (
                        <span className="text-xs text-muted-foreground ml-auto shrink-0">
                          {(row as InfoRow).status}
                        </span>
                      )}
                    </div>
                  )
                })}
            </div>
          )}
        </div>
      )}

      {/* Mark Filed dialog — opens when a red renewal row is clicked */}
      {dialogRow && (
        <MarkFiledDialog
          row={dialogRow}
          onClose={() => setDialogRow(null)}
          onFiled={() => {
            setDialogRow(null)
            router.refresh()
          }}
        />
      )}
    </div>
  )
}
