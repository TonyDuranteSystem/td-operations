'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Clock,
  AlertCircle,
  Building2,
  ChevronDown,
  ChevronRight,
  Filter,
  CheckCircle2,
  Loader2,
  Plus,
  ChevronRightIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { differenceInDays, parseISO } from 'date-fns'
import { toast } from 'sonner'
import Link from 'next/link'
import { DragDropContext, Droppable, Draggable, type DropResult } from '@hello-pangea/dnd'
import { completeService, updateServiceStatus, advanceServiceStep } from '@/app/(dashboard)/services/actions'
import { EditServiceDialog } from '@/components/services/edit-service-dialog'
import { CreateServiceDialog } from '@/components/services/create-service-dialog'

interface ServiceItem {
  id: string
  service_name: string
  service_type: string
  account_id: string | null
  status: string | null
  current_step: number | null
  total_steps: number | null
  amount: number | null
  amount_currency: string | null
  blocked_waiting_external: boolean | null
  blocked_reason: string | null
  blocked_since: string | null
  sla_due_date: string | null
  stage_entered_at: string | null
  company_name: string | null
  notes: string | null
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

function CompleteButton({ serviceId, serviceName }: { serviceId: string; serviceName: string }) {
  const [isPending, startTransition] = useTransition()

  return (
    <button
      disabled={isPending}
      onClick={(e) => {
        e.stopPropagation()
        startTransition(async () => {
          const result = await completeService(serviceId)
          if (result.success) {
            toast.success('Service completed', { description: serviceName })
          } else {
            toast.error(result.error ?? 'Errore nel completare il servizio')
          }
        })
      }}
      className={cn(
        'inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded transition-colors',
        isPending
          ? 'bg-zinc-100 text-zinc-400 cursor-not-allowed'
          : 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200'
      )}
      title="Segna come completato"
    >
      {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
      <span className="hidden sm:inline">Completa</span>
    </button>
  )
}

function AdvanceStepButton({ serviceId, currentStep, totalSteps, updatedAt }: { serviceId: string; currentStep: number; totalSteps: number; updatedAt: string }) {
  const [isPending, startTransition] = useTransition()

  if (currentStep >= totalSteps) return null

  return (
    <button
      disabled={isPending}
      onClick={(e) => {
        e.stopPropagation()
        startTransition(async () => {
          const result = await advanceServiceStep(serviceId, updatedAt)
          if (result.success) {
            toast.success(`Step ${currentStep + 1}/${totalSteps}`)
          } else {
            toast.error(result.error ?? 'Errore')
          }
        })
      }}
      className={cn(
        'inline-flex items-center gap-0.5 px-1.5 py-1 text-xs font-medium rounded transition-colors',
        isPending
          ? 'bg-zinc-100 text-zinc-400 cursor-not-allowed'
          : 'bg-blue-100 text-blue-700 hover:bg-blue-200'
      )}
      title={`Avanza a step ${currentStep + 1}`}
    >
      {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <ChevronRightIcon className="h-3 w-3" />}
    </button>
  )
}

export function ServiceBoard({ columns, stats, serviceTypes, typeFilter, today }: ServiceBoardProps) {
  const router = useRouter()
  const [viewMode, setViewMode] = useState<'list' | 'kanban'>('kanban')
  const [showCreate, setShowCreate] = useState(false)
  const [editingService, setEditingService] = useState<ServiceItem | null>(null)

  return (
    <div className="space-y-6">
      {/* Stats */}
      <div className="flex gap-3 flex-wrap">
        <StatCard label="Total Active" value={stats.total} color="text-foreground" />
        <StatCard label="Not Started" value={stats.notStarted} color="text-zinc-600" />
        <StatCard label="In Progress" value={stats.inProgress} color="text-blue-600" />
        <StatCard label="Blocked" value={stats.blocked} color="text-red-600" />
        <StatCard label="SLA Overdue" value={stats.withSla} color="text-amber-600" />
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
            <option value="">All types</option>
            {serviceTypes.map(st => (
              <option key={st.type} value={st.type}>
                {st.type} ({st.count})
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowCreate(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-zinc-900 text-white hover:bg-zinc-800 transition-colors"
          >
            <Plus className="h-3.5 w-3.5" />
            New Service
          </button>
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
        <ListView columns={columns} today={today} onEditService={setEditingService} />
      ) : (
        <KanbanView columns={columns} today={today} onEditService={setEditingService} />
      )}

      {/* Dialogs */}
      <CreateServiceDialog open={showCreate} onClose={() => setShowCreate(false)} />
      {editingService && (
        <EditServiceDialog
          open={!!editingService}
          onClose={() => setEditingService(null)}
          service={{
            ...editingService,
            account_id: editingService.account_id ?? '',
            status: editingService.status ?? 'Not Started',
            blocked_waiting_external: editingService.blocked_waiting_external ?? false,
            company_name: editingService.company_name ?? '',
          }}
        />
      )}
    </div>
  )
}

/* -- List View ------------------------------------------------- */

function ListView({ columns, today, onEditService }: { columns: Column[]; today: string; onEditService: (s: ServiceItem) => void }) {
  return (
    <div className="space-y-2">
      {columns.map(col => (
        <StatusSection key={col.status} column={col} today={today} onEditService={onEditService} />
      ))}
    </div>
  )
}

function StatusSection({ column, today, onEditService }: { column: Column; today: string; onEditService: (s: ServiceItem) => void }) {
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
              <ServiceCard key={s.id} service={s} today={today} showComplete onClick={() => onEditService(s)} />
            ))
          )}
        </div>
      )}
    </div>
  )
}

function ServiceCard({ service: s, today, showComplete = false, onClick }: { service: ServiceItem; today: string; showComplete?: boolean; onClick?: () => void }) {
  const isBlocked = s.blocked_waiting_external === true
  const hasSla = s.sla_due_date != null
  let slaDays: number | null = null
  let slaOverdue = false
  if (hasSla) {
    slaDays = differenceInDays(parseISO(s.sla_due_date!), parseISO(today))
    slaOverdue = slaDays < 0
  }

  return (
    <div
      className={cn(
        'bg-white rounded-lg border p-3 text-sm cursor-pointer hover:ring-2 hover:ring-blue-200 transition-all',
        isBlocked && 'border-red-200 bg-red-50/50',
        slaOverdue && !isBlocked && 'border-amber-200 bg-amber-50/50'
      )}
      onClick={onClick}
    >
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-600">
          {s.service_type}
        </span>
        <div className="flex items-center gap-1">
          {isBlocked && (
            <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-red-100 text-red-700">BLOCKED</span>
          )}
          {slaOverdue && (
            <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">SLA</span>
          )}
        </div>
      </div>
      <p className="font-medium text-sm leading-snug truncate">{s.service_name}</p>
      {s.company_name && (
        <Link
          href={`/accounts/${s.account_id}`}
          onClick={e => e.stopPropagation()}
          className="flex items-center gap-1 text-xs text-muted-foreground mt-0.5 hover:text-blue-600"
        >
          <Building2 className="h-3 w-3" />
          <span className="truncate">{s.company_name}</span>
        </Link>
      )}
      <div className="flex items-center justify-between mt-2 text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          {s.current_step != null && s.total_steps != null && (
            <>
              <span>Step {s.current_step}/{s.total_steps}</span>
              <AdvanceStepButton
                serviceId={s.id}
                currentStep={s.current_step}
                totalSteps={s.total_steps}
                updatedAt={s.updated_at}
              />
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          {slaDays !== null && (
            <span className={cn(
              'flex items-center gap-1',
              slaDays < 0 ? 'text-red-600 font-medium' : slaDays <= 3 ? 'text-amber-600' : ''
            )}>
              <Clock className="h-3 w-3" />
              {slaDays < 0 ? `${Math.abs(slaDays)}d overdue` : slaDays === 0 ? 'Today' : `${slaDays}d`}
            </span>
          )}
          {showComplete && s.status === 'In Progress' && (
            <CompleteButton serviceId={s.id} serviceName={s.service_name} />
          )}
        </div>
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

/* -- Kanban View with Drag & Drop ------------------------------ */

function KanbanView({ columns, today, onEditService }: { columns: Column[]; today: string; onEditService: (s: ServiceItem) => void }) {
  const [cols, setCols] = useState(columns)
  const [, startTransition] = useTransition()

  function handleDragEnd(result: DropResult) {
    if (!result.destination) return
    const srcStatus = result.source.droppableId
    const dstStatus = result.destination.droppableId
    if (srcStatus === dstStatus && result.source.index === result.destination.index) return

    const newCols = cols.map(c => ({ ...c, items: [...c.items] }))
    const srcCol = newCols.find(c => c.status === srcStatus)
    const dstCol = newCols.find(c => c.status === dstStatus)
    if (!srcCol || !dstCol) return

    const [moved] = srcCol.items.splice(result.source.index, 1)
    dstCol.items.splice(result.destination.index, 0, { ...moved, status: dstStatus })
    setCols(newCols)

    // Persist to DB
    if (srcStatus !== dstStatus) {
      startTransition(async () => {
        const result = await updateServiceStatus(moved.id, dstStatus)
        if (result.success) {
          toast.success(`Service moved to "${dstStatus}"`, { description: moved.service_name })
        } else {
          toast.error(result.error ?? 'Errore nello spostamento del servizio')
          setCols(columns) // revert
        }
      })
    }
  }

  return (
    <DragDropContext onDragEnd={handleDragEnd}>
      <div className="flex gap-4 overflow-x-auto pb-4">
        {cols.map(col => {
          const colors = STATUS_COLORS[col.status] ?? STATUS_COLORS['Not Started']
          return (
            <div key={col.status} className="flex-shrink-0 w-80">
              <div className="flex items-center gap-2 mb-3">
                <span className="font-semibold text-xs uppercase tracking-wide">{col.status}</span>
                <span className={cn('text-xs font-medium px-2 py-0.5 rounded-full', colors.bg, colors.text)}>
                  {col.items.length}
                </span>
              </div>
              <Droppable droppableId={col.status}>
                {(provided, snapshot) => (
                  <div
                    ref={provided.innerRef}
                    {...provided.droppableProps}
                    className={cn(
                      'space-y-2 max-h-[70vh] overflow-y-auto min-h-[60px] rounded-lg p-1 transition-colors',
                      snapshot.isDraggingOver && 'bg-blue-50 ring-2 ring-blue-200'
                    )}
                  >
                    {col.items.map((s, index) => (
                      <Draggable key={s.id} draggableId={s.id} index={index}>
                        {(provided, snapshot) => (
                          <div
                            ref={provided.innerRef}
                            {...provided.draggableProps}
                            {...provided.dragHandleProps}
                            className={cn(snapshot.isDragging && 'opacity-90 rotate-1 shadow-lg')}
                          >
                            <ServiceCard service={s} today={today} showComplete onClick={() => onEditService(s)} />
                          </div>
                        )}
                      </Draggable>
                    ))}
                    {provided.placeholder}
                    {col.items.length === 0 && !snapshot.isDraggingOver && (
                      <div className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
                        Trascina qui
                      </div>
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
