'use client'

import { useState, useTransition } from 'react'
import {
  ChevronDown,
  ChevronRight,
  DollarSign,
  Building2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import Link from 'next/link'
import { DragDropContext, Droppable, Draggable, type DropResult } from '@hello-pangea/dnd'
import { updateDealStage } from '@/app/(dashboard)/pipeline/actions'

interface DealItem {
  id: string
  deal_name: string
  account_id: string | null
  stage: string | null
  amount: number | null
  amount_currency: string | null
  close_date: string | null
  deal_type: string | null
  deal_category: string | null
  service_type: string | null
  payment_status: string | null
  company_name: string | null
  created_at: string
}

interface StageGroup {
  stage: string
  deals: DealItem[]
  total: number
}

interface PipelineStats {
  total: number
  totalValue: number
  open: number
  openValue: number
  closedWon: number
  closedWonValue: number
}

const STAGE_COLORS: Record<string, { badge: string }> = {
  'Initial Consultation': { badge: 'bg-zinc-100 text-zinc-700' },
  'Offer Sent': { badge: 'bg-amber-100 text-amber-700' },
  'Negotiation': { badge: 'bg-blue-100 text-blue-700' },
  'Agreement Signed': { badge: 'bg-indigo-100 text-indigo-700' },
  'Closed Won': { badge: 'bg-emerald-100 text-emerald-700' },
}

const PAYMENT_COLORS: Record<string, string> = {
  Paid: 'bg-emerald-100 text-emerald-700',
  Pending: 'bg-amber-100 text-amber-700',
  Overdue: 'bg-red-100 text-red-700',
  'Partially Paid': 'bg-orange-100 text-orange-700',
}

function formatCurrency(amount: number): string {
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
}

function StatCard({ label, value, sub, color }: { label: string; value: string; sub: string; color: string }) {
  return (
    <div className="bg-white rounded-lg border p-4 flex-1 min-w-[120px]">
      <p className={cn('text-2xl font-semibold', color)}>{value}</p>
      <p className="text-xs text-muted-foreground mt-1">{label}</p>
      <p className="text-xs text-muted-foreground">{sub}</p>
    </div>
  )
}

export function PipelineBoard({ stages, stats }: { stages: StageGroup[]; stats: PipelineStats }) {
  const [viewMode, setViewMode] = useState<'list' | 'kanban'>('kanban')

  return (
    <div className="space-y-6">
      <div className="flex gap-3 flex-wrap">
        <StatCard label="Pipeline Aperta" value={formatCurrency(stats.openValue)} sub={`${stats.open} deal`} color="text-blue-600" />
        <StatCard label="Closed Won" value={formatCurrency(stats.closedWonValue)} sub={`${stats.closedWon} deal`} color="text-emerald-600" />
        <StatCard label="Totale" value={formatCurrency(stats.totalValue)} sub={`${stats.total} deal`} color="text-foreground" />
      </div>

      <div className="flex items-center gap-2">
        <button onClick={() => setViewMode('list')} className={cn('px-3 py-1.5 text-xs font-medium rounded-lg transition-colors', viewMode === 'list' ? 'bg-zinc-900 text-white' : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200')}>Lista</button>
        <button onClick={() => setViewMode('kanban')} className={cn('px-3 py-1.5 text-xs font-medium rounded-lg transition-colors', viewMode === 'kanban' ? 'bg-zinc-900 text-white' : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200')}>Kanban</button>
      </div>

      {viewMode === 'list' ? <ListView stages={stages} /> : <KanbanView stages={stages} />}
    </div>
  )
}

function ListView({ stages }: { stages: StageGroup[] }) {
  return (
    <div className="space-y-2">
      {stages.map(group => (
        <StageSection key={group.stage} group={group} defaultOpen={group.stage !== 'Closed Won'} />
      ))}
    </div>
  )
}

function StageSection({ group, defaultOpen }: { group: StageGroup; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const colors = STAGE_COLORS[group.stage] ?? STAGE_COLORS['Initial Consultation']

  return (
    <div>
      <button onClick={() => setOpen(!open)} className="flex items-center gap-2 w-full py-3 text-left">
        {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
        <span className="font-semibold text-sm uppercase tracking-wide">{group.stage}</span>
        <span className={cn('text-xs font-medium px-2 py-0.5 rounded-full ml-1', colors.badge)}>{group.deals.length}</span>
        <span className="text-xs text-muted-foreground ml-auto">{formatCurrency(group.total)}</span>
      </button>
      {open && (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 pb-4">
          {group.deals.length === 0 ? (
            <p className="text-sm text-muted-foreground col-span-full pl-6">Nessun deal</p>
          ) : group.deals.map(deal => <DealCard key={deal.id} deal={deal} />)}
        </div>
      )}
    </div>
  )
}

function DealCard({ deal }: { deal: DealItem }) {
  return (
    <div className="bg-white rounded-lg border p-3 text-sm hover:shadow-sm transition-shadow">
      <p className="font-medium leading-snug line-clamp-2">{deal.deal_name}</p>
      {deal.company_name && (
        <Link href={`/accounts/${deal.account_id}`} className="flex items-center gap-1 text-xs text-muted-foreground mt-1 hover:text-blue-600 transition-colors">
          <Building2 className="h-3 w-3" />{deal.company_name}
        </Link>
      )}
      <div className="flex items-center justify-between mt-2">
        <div className="flex items-center gap-1.5">
          {deal.amount != null && (
            <span className="flex items-center gap-0.5 text-sm font-semibold">
              <DollarSign className="h-3.5 w-3.5 text-muted-foreground" />{deal.amount.toLocaleString()}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {deal.service_type && <span className="text-xs px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-600 truncate max-w-[100px]">{deal.service_type}</span>}
          {deal.payment_status && <span className={cn('text-xs px-1.5 py-0.5 rounded', PAYMENT_COLORS[deal.payment_status] ?? 'bg-zinc-100')}>{deal.payment_status}</span>}
        </div>
      </div>
    </div>
  )
}

function KanbanView({ stages }: { stages: StageGroup[] }) {
  const activeStages = stages.filter(s => s.stage !== 'Closed Won')
  const [cols, setCols] = useState(activeStages)
  const [, startTransition] = useTransition()

  function handleDragEnd(result: DropResult) {
    if (!result.destination) return
    const srcStage = result.source.droppableId
    const dstStage = result.destination.droppableId
    if (srcStage === dstStage && result.source.index === result.destination.index) return

    const newCols = cols.map(c => ({ ...c, deals: [...c.deals] }))
    const srcCol = newCols.find(c => c.stage === srcStage)
    const dstCol = newCols.find(c => c.stage === dstStage)
    if (!srcCol || !dstCol) return

    const [moved] = srcCol.deals.splice(result.source.index, 1)
    srcCol.total -= (moved.amount ?? 0)
    dstCol.deals.splice(result.destination.index, 0, { ...moved, stage: dstStage })
    dstCol.total += (moved.amount ?? 0)
    setCols(newCols)

    if (srcStage !== dstStage) {
      startTransition(async () => {
        try {
          await updateDealStage(moved.id, dstStage)
          toast.success(`Deal spostato in "${dstStage}"`, { description: moved.deal_name })
        } catch {
          toast.error('Errore nello spostamento del deal')
          setCols(activeStages)
        }
      })
    }
  }

  return (
    <DragDropContext onDragEnd={handleDragEnd}>
      <div className="flex gap-4 overflow-x-auto pb-4">
        {cols.map(group => {
          const colors = STAGE_COLORS[group.stage] ?? STAGE_COLORS['Initial Consultation']
          return (
            <div key={group.stage} className="flex-shrink-0 w-72">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-xs uppercase tracking-wide">{group.stage}</span>
                  <span className={cn('text-xs font-medium px-2 py-0.5 rounded-full', colors.badge)}>{group.deals.length}</span>
                </div>
                <span className="text-xs text-muted-foreground">{formatCurrency(group.total)}</span>
              </div>
              <Droppable droppableId={group.stage}>
                {(provided, snapshot) => (
                  <div
                    ref={provided.innerRef}
                    {...provided.droppableProps}
                    className={cn('space-y-2 min-h-[60px] rounded-lg p-1 transition-colors', snapshot.isDraggingOver && 'bg-blue-50 ring-2 ring-blue-200')}
                  >
                    {group.deals.map((deal, index) => (
                      <Draggable key={deal.id} draggableId={deal.id} index={index}>
                        {(provided, snapshot) => (
                          <div ref={provided.innerRef} {...provided.draggableProps} {...provided.dragHandleProps} className={cn(snapshot.isDragging && 'opacity-90 rotate-1 shadow-lg')}>
                            <DealCard deal={deal} />
                          </div>
                        )}
                      </Draggable>
                    ))}
                    {provided.placeholder}
                    {group.deals.length === 0 && !snapshot.isDraggingOver && (
                      <div className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">Trascina qui</div>
                    )}
                  </div>
                )}
              </Droppable>
            </div>
          )
        })}
      </div>
    </DragDropContext>
  )
}
