'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { parseISO } from 'date-fns'

interface DeadlineItem {
  type: string
  company_name: string
  deadline_date: string
  status?: string
}

const MONTHS = [
  'Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno',
  'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre',
]

const TYPE_COLORS: Record<string, string> = {
  'Tax Return': 'bg-indigo-500',
  'RA Renewal': 'bg-amber-500',
  'Payment': 'bg-red-500',
  'Service SLA': 'bg-blue-500',
}

const TYPE_BADGE_COLORS: Record<string, string> = {
  'Tax Return': 'bg-indigo-100 text-indigo-700',
  'RA Renewal': 'bg-amber-100 text-amber-700',
  'Payment': 'bg-red-100 text-red-700',
  'Service SLA': 'bg-blue-100 text-blue-700',
}

interface AnnualCalendarProps {
  deadlines: DeadlineItem[]
  year: number
  today: string
}

export function AnnualCalendar({ deadlines, year, today }: AnnualCalendarProps) {
  const router = useRouter()
  const [selectedMonth, setSelectedMonth] = useState<number | null>(null)
  const [typeFilter, setTypeFilter] = useState<string>('')

  const filtered = typeFilter
    ? deadlines.filter(d => d.type === typeFilter)
    : deadlines

  // Group by month
  const monthGroups: DeadlineItem[][] = Array.from({ length: 12 }, () => [])
  for (const d of filtered) {
    try {
      const month = parseISO(d.deadline_date).getMonth()
      monthGroups[month].push(d)
    } catch {
      // skip invalid dates
    }
  }

  // Count by type for legend
  const typeCounts: Record<string, number> = {}
  for (const d of deadlines) {
    typeCounts[d.type] = (typeCounts[d.type] ?? 0) + 1
  }

  const todayMonth = parseISO(today).getMonth()

  return (
    <div className="space-y-6">
      {/* Year navigation + filters */}
      <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.push(`/calendar?year=${year - 1}`)}
            className="p-1.5 rounded-lg hover:bg-zinc-100"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <span className="font-semibold text-lg">{year}</span>
          <button
            onClick={() => router.push(`/calendar?year=${year + 1}`)}
            className="p-1.5 rounded-lg hover:bg-zinc-100"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        </div>

        {/* Legend / filter */}
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setTypeFilter('')}
            className={cn(
              'text-xs px-2.5 py-1 rounded-full font-medium transition-colors',
              !typeFilter ? 'bg-zinc-900 text-white' : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'
            )}
          >
            Tutti ({deadlines.length})
          </button>
          {Object.entries(typeCounts).map(([type, count]) => (
            <button
              key={type}
              onClick={() => setTypeFilter(typeFilter === type ? '' : type)}
              className={cn(
                'text-xs px-2.5 py-1 rounded-full font-medium transition-colors flex items-center gap-1.5',
                typeFilter === type
                  ? 'bg-zinc-900 text-white'
                  : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'
              )}
            >
              <span className={cn('w-2 h-2 rounded-full', TYPE_COLORS[type] ?? 'bg-zinc-400')} />
              {type} ({count})
            </button>
          ))}
        </div>
      </div>

      {/* 12-month grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        {MONTHS.map((name, i) => {
          const items = monthGroups[i]
          const isPast = year < parseISO(today).getFullYear() || (year === parseISO(today).getFullYear() && i < todayMonth)
          const isCurrent = year === parseISO(today).getFullYear() && i === todayMonth

          return (
            <button
              key={i}
              onClick={() => setSelectedMonth(selectedMonth === i ? null : i)}
              className={cn(
                'bg-white rounded-lg border p-3 text-left transition-all hover:shadow-sm',
                selectedMonth === i && 'ring-2 ring-blue-500',
                isCurrent && 'border-blue-300',
                isPast && 'opacity-60'
              )}
            >
              <div className="flex items-center justify-between mb-2">
                <span className={cn(
                  'font-semibold text-sm',
                  isCurrent && 'text-blue-600'
                )}>
                  {name}
                </span>
                {items.length > 0 && (
                  <span className="text-xs font-medium px-1.5 py-0.5 rounded-full bg-zinc-100 text-zinc-600">
                    {items.length}
                  </span>
                )}
              </div>

              {/* Type dots */}
              <div className="flex gap-0.5 flex-wrap">
                {items.slice(0, 20).map((item, j) => (
                  <span
                    key={j}
                    className={cn('w-2 h-2 rounded-full', TYPE_COLORS[item.type] ?? 'bg-zinc-400')}
                    title={`${item.type}: ${item.company_name}`}
                  />
                ))}
                {items.length > 20 && (
                  <span className="text-xs text-muted-foreground ml-1">+{items.length - 20}</span>
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
            {MONTHS[selectedMonth]} {year} — {monthGroups[selectedMonth].length} scadenze
          </h3>
          {monthGroups[selectedMonth].length === 0 ? (
            <p className="text-sm text-muted-foreground">Nessuna scadenza</p>
          ) : (
            <div className="space-y-2">
              {monthGroups[selectedMonth]
                .sort((a, b) => a.deadline_date.localeCompare(b.deadline_date))
                .map((item, i) => (
                  <div key={i} className="flex items-center gap-3 py-1.5 border-b last:border-b-0 text-sm">
                    <span className={cn('w-2 h-2 rounded-full shrink-0', TYPE_COLORS[item.type] ?? 'bg-zinc-400')} />
                    <span className="text-xs text-muted-foreground min-w-[70px]">
                      {item.deadline_date.split('-').reverse().join('/')}
                    </span>
                    <span className={cn('text-xs font-medium px-1.5 py-0.5 rounded shrink-0', TYPE_BADGE_COLORS[item.type] ?? 'bg-zinc-100')}>
                      {item.type}
                    </span>
                    <span className="font-medium truncate">{item.company_name}</span>
                    {item.status && (
                      <span className="text-xs text-muted-foreground ml-auto shrink-0">{item.status}</span>
                    )}
                  </div>
                ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
