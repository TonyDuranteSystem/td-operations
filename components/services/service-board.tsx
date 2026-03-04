'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Clock,
  AlertCircle,
  Building2,
  ChevronDown,
  ChevronRight,
  Filter,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { differenceInDays, parseISO } from 'date-fns'
import Link from 'next/link'

interface ServiceItem {
  id: string
  service_name: string
  service_type: string
  account_id: string | null
  status: string | null
  current_step: number | null
  total_steps: number | null
  blocked_waiting_external: boolean | null
  blocked_reason: string | null
  blocked_since: string | null
  sla_due_date: string | null
  stage_entered_at: string | null
  company_name: string | null
  updated_at: string
}

interface Column {
  status: string
  items: ServiceItem[]
}

interface ServiceBoardProps {
  columns: Column[]
  stats: { total: number; notStarted: number; inProgress: number; blocked: number; withSla: number }
  serviceTypes: { type: string; count: number }[]
  typeFilter: string
  today: string
}

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  'Not Started': { bg: 'bg-zinc-100', text: 'text-zinc-700' },
  'In Progress': { bg: 'bg-blue-100', text: 'text-blue-700' },
  Blocked: { bg: 'bg-red-100', text: 'text-red-700' },
}

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="bg-white rounded-lg border p-4 flex-1 min-w-[100px]">
      <p className={cn('text-2xl font-semibold', color)}>{value}</p>
      <p className="text-xs text-muted-foreground mt-1">{label}</p>
    </div>
  )
}

export function ServiceBoard({ columns, stats, serviceTypes, typeFilter, today }: ServiceBoardProps) {
  const router = useRouter()
  const [viewMode, setViewMode] = useState<'list' | 'kanban'>('list')

  return (
    <div className="space-y-6">
      {/* Stats */}
      <div className="flex gap-3 flex-wrap">
        <StatCard label="Totale Attivi" value={stats.total} color="text-foreground" />
        <StatCard label="Da Iniziare" value={stats.notStarted} color="text-zinc-600" />
        <StatCard label="In Corso" value={stats.inProgress} color="text-blue-600" />
        <StatCard label="Bloccati" value={stats.blocked} color="text-red-600" />
        <StatCard label="SLA Scaduti" value={stats.withSla} color="text-amber-600" />
      </div>

      {/* Filters + view toggle */}
      <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-muted-foreground" />
          <select
            value={typeFilter}
            onChange={e => router.push(`/services${e.target.value ? `?type=${encodeURIComponent(e.target.value)}` : ''}`)}
            className="px-3 py-1.5 rounded-lg border bg-white text-sm"
          >
            <option value="">Tutti i tipi</option>
            {serviceTypes.map(st => (
              <option key={st.type} value={st.type}>
                {st.type} ({st.count})
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setViewMode('list')}
            className={cn(
              'px-3 py-1.5 text-xs font-medium rounded-lg transition-colors',
              viewMode === 'list' ? 'bg-zinc-900 text-white' : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'
            )}
          >
            Lista
          </button>
          <button
            onClick={() => setViewMode('kanban')}
            className={cn(
              'px-3 py-1.5 text-xs font-medium rounded-lg transition-colors',
              viewMode === 'kanban' ? 'bg-zinc-900 text-white' : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'
            )}
          >
            Kanban
          </button>
        </div>
      </div>

      {/* Content */}
      {viewMode === 'list' ? (
        <ListView columns={columns} today={today} />
      ) : (
        <KanbanView columns={columns} today={today} />
      )}
    </div>
  )
}

/* ── List View ───────────────────────────────────── */

function ListView({ columns, today }: { columns: Column[]; today: string }) {
  return (
    <div className="space-y-2">
      {columns.map(col => (
        <StatusSection key={col.status} column={col} today={today} />
      ))}
    </div>
  )
}

function StatusSection({ column, today }: { column: Column; today: string }) {
  const [open, setOpen] = useState(true)
  const colors = STATUS_COLORS[column.status] ?? STATUS_COLORS['Not Started']

  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 w-full py-3 text-left"
      >
        {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
        <span className="font-semibold text-sm uppercase tracking-wide">{column.status}</span>
        <span className={cn('text-xs font-medium px-2 py-0.5 rounded-full ml-1', colors.bg, colors.text)}>
          {column.items.length}
        </span>
      </button>
      {open && (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 pb-4">
          {column.items.length === 0 ? (
            <p className="text-sm text-muted-foreground col-span-full pl-6">Nessun servizio</p>
          ) : (
            column.items.map(s => (
              <ServiceCard key={s.id} service={s} today={today} />
            ))
          )}
        </div>
      )}
    </div>
  )
}

function ServiceCard({ service: s, today }: { service: ServiceItem; today: string }) {
  const isBlocked = s.blocked_waiting_external === true
  const hasSla = s.sla_due_date != null
  let slaDays: number | null = null
  let slaOverdue = false
  if (hasSla) {
    slaDays = differenceInDays(parseISO(s.sla_due_date!), parseISO(today))
    slaOverdue = slaDays < 0
  }

  return (
    <div className={cn(
      'bg-white rounded-lg border p-3 text-sm',
      isBlocked && 'border-red-200 bg-red-50/50',
      slaOverdue && !isBlocked && 'border-amber-200 bg-amber-50/50'
    )}>
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-600">
          {s.service_type}
        </span>
        <div className="flex items-center gap-1">
          {isBlocked && (
            <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-red-100 text-red-700">
              BLOCKED
            </span>
          )}
          {slaOverdue && (
            <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">
              SLA
            </span>
          )}
        </div>
      </div>
      <p className="font-medium text-sm leading-snug truncate">{s.service_name}</p>
      {s.company_name && (
        <Link
          href={`/accounts/${s.account_id}`}
          className="flex items-center gap-1 text-xs text-muted-foreground mt-0.5 hover:text-blue-600"
        >
          <Building2 className="h-3 w-3" />
          <span className="truncate">{s.company_name}</span>
        </Link>
      )}
      <div className="flex items-center justify-between mt-2 text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          {s.current_step != null && s.total_steps != null && (
            <span>Step {s.current_step}/{s.total_steps}</span>
          )}
        </div>
        {slaDays !== null && (
          <span className={cn(
            'flex items-center gap-1',
            slaDays < 0 ? 'text-red-600 font-medium' :
            slaDays <= 3 ? 'text-amber-600' : ''
          )}>
            <Clock className="h-3 w-3" />
            {slaDays < 0 ? `${Math.abs(slaDays)}g scaduto` :
             slaDays === 0 ? 'Oggi' : `${slaDays}g`}
          </span>
        )}
      </div>
      {isBlocked && s.blocked_reason && (
        <p className="text-xs text-red-600 mt-1 flex items-center gap-1">
          <AlertCircle className="h-3 w-3 shrink-0" />
          <span className="truncate">{s.blocked_reason}</span>
        </p>
      )}
    </div>
  )
}

/* ── Kanban View ───────────────────────────────────── */

function KanbanView({ columns, today }: { columns: Column[]; today: string }) {
  return (
    <div className="flex gap-4 overflow-x-auto pb-4">
      {columns.map(col => {
        const colors = STATUS_COLORS[col.status] ?? STATUS_COLORS['Not Started']
        return (
          <div key={col.status} className="flex-shrink-0 w-80">
            <div className="flex items-center gap-2 mb-3">
              <span className="font-semibold text-xs uppercase tracking-wide">{col.status}</span>
              <span className={cn('text-xs font-medium px-2 py-0.5 rounded-full', colors.bg, colors.text)}>
                {col.items.length}
              </span>
            </div>
            <div className="space-y-2 max-h-[70vh] overflow-y-auto">
              {col.items.map(s => (
                <ServiceCard key={s.id} service={s} today={today} />
              ))}
              {col.items.length === 0 && (
                <div className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
                  Nessun servizio
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
