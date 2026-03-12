'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { cn } from '@/lib/utils'
import { Search, ChevronLeft, ChevronRight, ChevronDown, ChevronUp } from 'lucide-react'
import { format, parseISO } from 'date-fns'

interface AuditEntry {
  id: string
  actor: string
  action_type: string
  table_name: string
  record_id: string | null
  account_id: string | null
  summary: string
  details: Record<string, unknown>
  created_at: string
  company_name?: string | null
}

interface AuditStats {
  total: number
  byType: Record<string, number>
}

interface AuditFilters {
  q: string
  action: string
  table: string
  days: string
  page: number
}

interface Props {
  entries: AuditEntry[]
  stats: AuditStats
  filters: AuditFilters
  totalCount: number
  tableNames: string[]
}

const PAGE_SIZE = 50

const ACTION_COLORS: Record<string, string> = {
  create: 'bg-emerald-100 text-emerald-700',
  update: 'bg-blue-100 text-blue-700',
  delete: 'bg-red-100 text-red-700',
  send: 'bg-amber-100 text-amber-700',
  advance: 'bg-purple-100 text-purple-700',
  process: 'bg-indigo-100 text-indigo-700',
  execute_sql: 'bg-zinc-200 text-zinc-700',
}

const ACTION_TYPES = ['create', 'update', 'delete', 'send', 'advance', 'process', 'execute_sql']
const TIME_RANGES = [
  { label: '24h', value: '1' },
  { label: '7 giorni', value: '7' },
  { label: '30 giorni', value: '30' },
  { label: 'Tutto', value: 'all' },
]

export function AuditBoard({ entries, stats, filters, totalCount, tableNames }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [expandedId, setExpandedId] = useState<string | null>(null)

  function updateFilter(key: string, value: string) {
    startTransition(() => {
      const params = new URLSearchParams()
      const newFilters = { ...filters, [key]: value }
      // Reset page when changing filters
      if (key !== 'page') newFilters.page = 1

      if (newFilters.q) params.set('q', newFilters.q)
      if (newFilters.action) params.set('action', newFilters.action)
      if (newFilters.table) params.set('table', newFilters.table)
      if (newFilters.days && newFilters.days !== '7') params.set('days', newFilters.days)
      if (newFilters.page > 1) params.set('page', String(newFilters.page))

      const qs = params.toString()
      router.push(`/audit${qs ? `?${qs}` : ''}`)
    })
  }

  const totalPages = Math.ceil(totalCount / PAGE_SIZE)
  const startItem = (filters.page - 1) * PAGE_SIZE + 1
  const endItem = Math.min(filters.page * PAGE_SIZE, totalCount)

  return (
    <div className={cn('space-y-4', isPending && 'opacity-60 pointer-events-none')}>
      {/* Stats */}
      <div className="flex gap-3 flex-wrap">
        <div className="bg-white rounded-lg border p-4 flex-1 min-w-[120px]">
          <div className="text-2xl font-semibold">{stats.total}</div>
          <div className="text-xs text-muted-foreground">Totale azioni</div>
        </div>
        {ACTION_TYPES.filter(t => stats.byType[t]).map(type => (
          <div key={type} className="bg-white rounded-lg border p-4 flex-1 min-w-[100px]">
            <div className="text-2xl font-semibold">{stats.byType[type]}</div>
            <div className="text-xs text-muted-foreground capitalize">{type}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
          <input
            type="text"
            placeholder="Cerca nel summary..."
            defaultValue={filters.q}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                updateFilter('q', (e.target as HTMLInputElement).value)
              }
            }}
            className="w-full pl-9 pr-4 py-2 rounded-lg border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-zinc-200"
          />
        </div>
        <select
          value={filters.action}
          onChange={(e) => updateFilter('action', e.target.value)}
          className="px-3 py-2 rounded-lg border bg-white text-sm"
        >
          <option value="">Tutte le azioni</option>
          {ACTION_TYPES.map(t => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <select
          value={filters.table}
          onChange={(e) => updateFilter('table', e.target.value)}
          className="px-3 py-2 rounded-lg border bg-white text-sm"
        >
          <option value="">Tutte le tabelle</option>
          {tableNames.map(t => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <select
          value={filters.days}
          onChange={(e) => updateFilter('days', e.target.value)}
          className="px-3 py-2 rounded-lg border bg-white text-sm"
        >
          {TIME_RANGES.map(r => (
            <option key={r.value} value={r.value}>{r.label}</option>
          ))}
        </select>
      </div>

      {/* Table */}
      <div className="bg-white rounded-lg border overflow-hidden">
        {/* Header */}
        <div className="hidden md:grid md:grid-cols-[140px_80px_100px_1fr_120px_80px] gap-3 px-4 py-2.5 border-b bg-zinc-50 text-xs font-medium text-zinc-500 uppercase tracking-wide">
          <div>Data</div>
          <div>Azione</div>
          <div>Tabella</div>
          <div>Summary</div>
          <div>Account</div>
          <div>Actor</div>
        </div>

        {entries.length === 0 && (
          <div className="px-4 py-12 text-center text-sm text-zinc-400">
            Nessuna azione trovata per i filtri selezionati
          </div>
        )}

        {entries.map((entry) => {
          const isExpanded = expandedId === entry.id
          const hasDetails = entry.details && Object.keys(entry.details).length > 0

          return (
            <div key={entry.id} className="border-b last:border-b-0">
              <div
                className={cn(
                  'grid grid-cols-1 md:grid-cols-[140px_80px_100px_1fr_120px_80px] gap-1 md:gap-3 px-4 py-3 hover:bg-zinc-50 transition-colors',
                  hasDetails && 'cursor-pointer'
                )}
                onClick={() => hasDetails && setExpandedId(isExpanded ? null : entry.id)}
              >
                {/* Timestamp */}
                <div className="text-sm text-zinc-600 flex items-center gap-1">
                  <span className="md:hidden text-xs text-zinc-400 mr-1">Data:</span>
                  {format(parseISO(entry.created_at), 'dd MMM HH:mm')}
                  {hasDetails && (
                    isExpanded
                      ? <ChevronUp className="h-3 w-3 text-zinc-400 hidden md:block" />
                      : <ChevronDown className="h-3 w-3 text-zinc-400 hidden md:block" />
                  )}
                </div>

                {/* Action type */}
                <div>
                  <span className={cn(
                    'inline-block px-2 py-0.5 rounded-full text-xs font-medium',
                    ACTION_COLORS[entry.action_type] || 'bg-zinc-100 text-zinc-600'
                  )}>
                    {entry.action_type}
                  </span>
                </div>

                {/* Table name */}
                <div className="text-sm text-zinc-600 truncate">
                  <span className="md:hidden text-xs text-zinc-400 mr-1">Table:</span>
                  {entry.table_name}
                </div>

                {/* Summary */}
                <div className="text-sm text-zinc-800 truncate">
                  {entry.summary}
                </div>

                {/* Account */}
                <div className="text-sm text-zinc-500 truncate">
                  {entry.company_name || '—'}
                </div>

                {/* Actor */}
                <div className="text-xs text-zinc-400 truncate">
                  {entry.actor === 'claude.ai' ? 'AI' : entry.actor === 'claude.code' ? 'Code' : entry.actor}
                </div>
              </div>

              {/* Expanded details */}
              {isExpanded && hasDetails && (
                <div className="px-4 pb-3">
                  <pre className="bg-zinc-50 border rounded-md p-3 text-xs text-zinc-600 overflow-x-auto max-h-64 overflow-y-auto">
                    {JSON.stringify(entry.details, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-zinc-500">
            {startItem}–{endItem} di {totalCount}
          </span>
          <div className="flex items-center gap-1">
            <button
              disabled={filters.page <= 1}
              onClick={() => updateFilter('page', String(filters.page - 1))}
              className={cn(
                'p-2 rounded-md',
                filters.page <= 1 ? 'text-zinc-300 cursor-not-allowed' : 'hover:bg-zinc-100 text-zinc-600'
              )}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="px-3 py-1 text-zinc-600">
              {filters.page} / {totalPages}
            </span>
            <button
              disabled={filters.page >= totalPages}
              onClick={() => updateFilter('page', String(filters.page + 1))}
              className={cn(
                'p-2 rounded-md',
                filters.page >= totalPages ? 'text-zinc-300 cursor-not-allowed' : 'hover:bg-zinc-100 text-zinc-600'
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
