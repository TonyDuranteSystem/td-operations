'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import {
  daysInStage,
  stalenessLevel,
  isDroppableColumn,
  resolveDrop,
  summarizeBulkAdvance,
  OTHER_COLUMN_KEY,
  TAX_BOARD_ASSIGNEES,
  type BoardColumn,
  type BoardCard,
  type BulkAdvanceItem,
} from '@/lib/tax/tax-board'
import {
  advanceTaxBoardCard,
  bulkAssignTaxBoardCards,
  bulkAdvanceTaxBoardCards,
} from '@/app/(dashboard)/tax-returns/board-actions'
import { TaxKanbanCard } from './tax-kanban-card'
import { TaxCardDetail } from './tax-card-detail'

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
  const [selected, setSelected] = useState<{ card: BoardCard; columnLabel: string; staleDays: number | null } | null>(null)
  const [dragOverCol, setDragOverCol] = useState<string | null>(null)
  const [, startDrop] = useTransition()
  const router = useRouter()

  // ─── Slice 7c: bulk selection ───
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkBusy, startBulk] = useTransition()
  const [advanceConfirm, setAdvanceConfirm] = useState<{
    target: BoardColumn
    eligible: string[]
    skipped: { sdId: string; reason: string }[]
  } | null>(null)

  function toggleSelect(sdId: string) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(sdId)) next.delete(sdId)
      else next.add(sdId)
      return next
    })
  }
  function clearSelection() {
    setSelectedIds(new Set())
  }
  function exitSelection() {
    setSelectionMode(false)
    clearSelection()
    setAdvanceConfirm(null)
  }

  function handleDrop(targetCol: BoardColumn, e: React.DragEvent) {
    e.preventDefault()
    setDragOverCol(null)
    const raw = e.dataTransfer.getData('application/tax-card')
    if (!raw) return
    let payload: { sdId: string; sourceStage?: string }
    try {
      payload = JSON.parse(raw)
    } catch {
      return
    }
    const source = { stage_name: payload.sourceStage ?? '', isOther: false }
    const decision = resolveDrop(source, { stage_name: targetCol.stage_name, isOther: targetCol.isOther })
    if (!decision.ok) {
      if (decision.reason) toast.error(decision.reason)
      return
    }
    startDrop(async () => {
      const res = await advanceTaxBoardCard(payload.sdId, targetCol.stage_name)
      if (res.success) {
        toast.success(`Moved to ${targetCol.client_label ?? targetCol.stage_name}`)
        router.refresh()
      } else {
        toast.error(res.error ?? 'Move failed')
      }
    })
  }

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

  // sdId → the real-stage column it currently sits in (source for bulk advance).
  const sourceColBySd = useMemo(() => {
    const m = new Map<string, BoardColumn>()
    for (const col of filteredColumns) {
      if (!isDroppableColumn(col)) continue
      for (const card of col.cards) m.set(card.sdId, col)
    }
    return m
  }, [filteredColumns])

  function doBulkAssign(assignee: string | null) {
    const ids = Array.from(selectedIds)
    if (ids.length === 0) return
    startBulk(async () => {
      const res = await bulkAssignTaxBoardCards(ids, assignee)
      if (res.success) {
        toast.success(`Assigned ${res.data?.updated ?? ids.length} to ${assignee ?? 'Unassigned'}`)
        exitSelection()
        router.refresh()
      } else {
        toast.error(res.error ?? 'Bulk assign failed')
      }
    })
  }

  function openAdvanceConfirm(target: BoardColumn) {
    const ids = Array.from(selectedIds)
    const items: BulkAdvanceItem[] = ids.map(sdId => {
      const col = sourceColBySd.get(sdId)
      return { sdId, source: { stage_name: col?.stage_name ?? '', isOther: col?.isOther ?? true } }
    })
    const { eligible, skipped } = summarizeBulkAdvance(items, { stage_name: target.stage_name, isOther: target.isOther })
    setAdvanceConfirm({ target, eligible, skipped })
  }

  function doBulkAdvance() {
    if (!advanceConfirm) return
    const target = advanceConfirm.target
    const ids = Array.from(selectedIds)
    startBulk(async () => {
      const res = await bulkAdvanceTaxBoardCards(ids, target.stage_name)
      if (res.success) {
        const r = res.data!
        const parts = [`${r.succeeded.length} moved`]
        if (r.skipped.length) parts.push(`${r.skipped.length} skipped`)
        if (r.failed.length) parts.push(`${r.failed.length} failed`)
        toast.success(`${target.client_label ?? target.stage_name}: ${parts.join(', ')} — clients not notified`)
        exitSelection()
        router.refresh()
      } else {
        toast.error(res.error ?? 'Bulk advance failed')
      }
    })
  }

  const realStageTargets = filteredColumns.filter(c => isDroppableColumn(c))

  return (
    <div className="space-y-4">
      {/* Stats + selection toggle */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-3">
          <Stat label="Showing" value={totals.total} />
          <Stat label="Paid" value={totals.paid} color="text-emerald-600" />
          <Stat label="Unpaid" value={totals.unpaid} color="text-amber-600" />
          <Stat label="Extension" value={totals.extension} color="text-purple-600" />
        </div>
        <button
          onClick={() => (selectionMode ? exitSelection() : setSelectionMode(true))}
          className={cn(
            'rounded-lg px-3 py-2 text-xs font-semibold transition-colors',
            selectionMode ? 'bg-zinc-800 text-white' : 'border bg-white text-zinc-600 hover:bg-zinc-50',
          )}
        >
          {selectionMode ? 'Done' : 'Select'}
        </button>
      </div>

      {/* Bulk action bar */}
      {selectionMode && (
        <div className="sticky top-0 z-20 flex flex-wrap items-center gap-2 rounded-xl border border-blue-200 bg-blue-50/80 px-3 py-2 backdrop-blur">
          <span className="text-xs font-semibold text-blue-900">{selectedIds.size} selected</span>
          <span className="mx-1 h-4 w-px bg-blue-200" />
          <span className="text-[11px] font-medium text-zinc-500">Assign</span>
          <button
            disabled={selectedIds.size === 0 || bulkBusy}
            onClick={() => doBulkAssign(null)}
            className="rounded-full bg-white px-2.5 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-100 disabled:opacity-50"
          >
            Unassigned
          </button>
          {TAX_BOARD_ASSIGNEES.map(name => (
            <button
              key={name}
              disabled={selectedIds.size === 0 || bulkBusy}
              onClick={() => doBulkAssign(name)}
              className="rounded-full bg-white px-2.5 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-100 disabled:opacity-50"
            >
              {name}
            </button>
          ))}
          <span className="mx-1 h-4 w-px bg-blue-200" />
          <span className="text-[11px] font-medium text-zinc-500">Move to</span>
          <select
            disabled={selectedIds.size === 0 || bulkBusy}
            value=""
            onChange={(e) => {
              const col = realStageTargets.find(c => c.stage_name === e.target.value)
              if (col) openAdvanceConfirm(col)
              e.target.value = ''
            }}
            className="rounded-lg border bg-white px-2 py-1 text-xs text-zinc-700 disabled:opacity-50"
          >
            <option value="">Stage…</option>
            {realStageTargets.map(c => (
              <option key={c.stage_name} value={c.stage_name}>
                {c.client_label ?? c.stage_name}
              </option>
            ))}
          </select>
          <span className="mx-1 h-4 w-px bg-blue-200" />
          <button
            disabled={selectedIds.size === 0 || bulkBusy}
            onClick={clearSelection}
            className="rounded-full px-2.5 py-1 text-xs font-medium text-zinc-500 hover:bg-white disabled:opacity-50"
          >
            Clear
          </button>
        </div>
      )}

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
        {filteredColumns.map(col => {
          const droppable = isDroppableColumn(col)
          return (
          <div
            key={col.stage_name}
            onDragOver={droppable ? (e) => { e.preventDefault(); if (dragOverCol !== col.stage_name) setDragOverCol(col.stage_name) } : undefined}
            onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOverCol(null) }}
            onDrop={(e) => handleDrop(col, e)}
            className={cn(
              'flex w-64 shrink-0 flex-col rounded-xl border bg-zinc-50/60',
              col.stage_name === OTHER_COLUMN_KEY && 'border-amber-300 bg-amber-50/40',
              droppable && dragOverCol === col.stage_name && 'ring-2 ring-blue-400 ring-offset-1',
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
                    draggable={droppable}
                    sourceStage={col.stage_name}
                    selectionMode={selectionMode}
                    selected={selectedIds.has(card.sdId)}
                    onToggleSelect={toggleSelect}
                    onSelect={c =>
                      setSelected({
                        card: c,
                        columnLabel: col.client_label ?? col.stage_name,
                        staleDays: col.stale_days,
                      })
                    }
                  />
                ))
              )}
            </div>
          </div>
          )
        })}
      </div>

      {selected && (
        <TaxCardDetail
          card={selected.card}
          columnLabel={selected.columnLabel}
          staleDays={selected.staleDays}
          nowIso={nowIso}
          onClose={() => setSelected(null)}
        />
      )}

      {/* Bulk advance confirm dialog */}
      {advanceConfirm && (
        <>
          <div className="fixed inset-0 z-50 bg-black/40" onClick={() => setAdvanceConfirm(null)} />
          <div className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl bg-white p-5 shadow-xl">
            <h3 className="text-base font-semibold text-zinc-800">
              Move to {advanceConfirm.target.client_label ?? advanceConfirm.target.stage_name}?
            </h3>
            <p className="mt-2 text-sm text-zinc-600">
              <span className="font-semibold text-emerald-700">{advanceConfirm.eligible.length}</span> return
              {advanceConfirm.eligible.length === 1 ? '' : 's'} will advance.
              {advanceConfirm.skipped.length > 0 && (
                <>
                  {' '}
                  <span className="font-semibold text-amber-700">{advanceConfirm.skipped.length}</span> will be
                  skipped (in review, off-pipeline, or already there).
                </>
              )}
            </p>
            <p className="mt-1 text-xs text-zinc-400">Clients are not notified.</p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setAdvanceConfirm(null)}
                disabled={bulkBusy}
                className="rounded-lg px-3 py-1.5 text-sm font-medium text-zinc-600 hover:bg-zinc-100 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={doBulkAdvance}
                disabled={bulkBusy || advanceConfirm.eligible.length === 0}
                className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {bulkBusy ? 'Moving…' : `Move ${advanceConfirm.eligible.length}`}
              </button>
            </div>
          </div>
        </>
      )}
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
