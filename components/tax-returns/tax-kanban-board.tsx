'use client'

import { useMemo, useState } from 'react'
import { cn } from '@/lib/utils'
import {
  daysInStage,
  stalenessLevel,
  OTHER_COLUMN_KEY,
  type BoardColumn,
} from '@/lib/tax/tax-board'
import { TaxKanbanCard } from './tax-kanban-card'

type ReturnFilter = 'all' | string
type PayFilter = 'all' | 'paid' | 'unpaid'

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'rounded-full px-3 py-1 text-xs font-medium transition-colors',
        active ? 'bg-zinc-800 text-white' : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200',
      )}
    >
      {children}
    </button>
  )
}

/**
 * Tax Board Kanban (Slice 6, REV 4.1 spec §6). Read-only positioning:
 * catalog-driven columns, days-in-stage traffic lights, counters, filters.
 * Drag-drop / bulk / assignees come in Slice 7.
 */
export function TaxKanbanBoard({
  columns,
  returnTypes,
  nowIso,
}: {
  columns: BoardColumn[]
  returnTypes: string[]
  nowIso: string
}) {
  const [returnFilter, setReturnFilter] = useState<ReturnFilter>('all')
  const [payFilter, setPayFilter] = useState<PayFilter>('all')
  const [staleOnly, setStaleOnly] = useState(false)

  const now = useMemo(() => new Date(nowIso), [nowIso])

  const filteredColumns = useMemo(() => {
    return columns.map(col => {
      const cards = col.cards.filter(card => {
        if (returnFilter !== 'all' && card.returnType !== returnFilter) return false
        if (payFilter === 'paid' && !card.paid) return false
        if (payFilter === 'unpaid' && card.paid) return false
        if (staleOnly) {
          const days = daysInStage(card.stageEnteredAt, now)
          if (stalenessLevel(days, col.stale_days) !== 'stale') return false
        }
        return true
      })
      return { ...col, cards, count: cards.length }
    })
  }, [columns, returnFilter, payFilter, staleOnly, now])

  const totals = useMemo(() => {
    const all = filteredColumns.flatMap(c => c.cards)
    return {
      total: all.length,
      paid: all.filter(c => c.paid).length,
      unpaid: all.filter(c => !c.paid).length,
      extension: all.filter(c => c.extensionFiled).length,
    }
  }, [filteredColumns])

  return (
    <div className="space-y-4">
      {/* Stats */}
      <div className="flex flex-wrap gap-3">
        <Stat label="Showing" value={totals.total} />
        <Stat label="Paid" value={totals.paid} color="text-emerald-600" />
        <Stat label="Unpaid" value={totals.unpaid} color="text-amber-600" />
        <Stat label="Extension" value={totals.extension} color="text-purple-600" />
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-zinc-400">Type</span>
        <FilterChip active={returnFilter === 'all'} onClick={() => setReturnFilter('all')}>
          All
        </FilterChip>
        {returnTypes.map(rt => (
          <FilterChip key={rt} active={returnFilter === rt} onClick={() => setReturnFilter(rt)}>
            {rt}
          </FilterChip>
        ))}
        <span className="ml-3 text-xs font-medium text-zinc-400">Payment</span>
        <FilterChip active={payFilter === 'all'} onClick={() => setPayFilter('all')}>
          All
        </FilterChip>
        <FilterChip active={payFilter === 'paid'} onClick={() => setPayFilter('paid')}>
          Paid
        </FilterChip>
        <FilterChip active={payFilter === 'unpaid'} onClick={() => setPayFilter('unpaid')}>
          Unpaid
        </FilterChip>
        <span className="ml-3 text-xs font-medium text-zinc-400">Stale</span>
        <FilterChip active={staleOnly} onClick={() => setStaleOnly(v => !v)}>
          Stale only
        </FilterChip>
      </div>

      {/* Columns */}
      <div className="flex gap-3 overflow-x-auto pb-4">
        {filteredColumns.map(col => (
          <div
            key={col.stage_name}
            className={cn(
              'flex w-64 shrink-0 flex-col rounded-xl border bg-zinc-50/60',
              col.stage_name === OTHER_COLUMN_KEY && 'border-amber-300 bg-amber-50/40',
            )}
          >
            <div className="sticky top-0 flex items-center justify-between gap-2 rounded-t-xl border-b bg-white/80 px-3 py-2 backdrop-blur">
              <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-600">
                {col.icon && <span aria-hidden>{col.icon}</span>}
                <span className="truncate">{col.client_label ?? col.stage_name}</span>
              </span>
              <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-500">
                {col.count}
              </span>
            </div>
            <div className="flex-1 space-y-2 p-2">
              {col.cards.length === 0 ? (
                <p className="px-1 py-3 text-center text-[11px] text-zinc-300">—</p>
              ) : (
                col.cards.map(card => (
                  <TaxKanbanCard
                    key={card.sdId}
                    card={card}
                    staleDays={col.stale_days}
                    nowIso={nowIso}
                  />
                ))
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function Stat({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div className="rounded-lg border bg-white px-4 py-2.5">
      <p className={cn('text-xl font-semibold', color ?? 'text-zinc-800')}>{value}</p>
      <p className="text-[11px] text-zinc-400">{label}</p>
    </div>
  )
}
