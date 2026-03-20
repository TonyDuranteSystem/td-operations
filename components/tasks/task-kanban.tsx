'use client'

import { useState, useMemo, useTransition } from 'react'
import { DragDropContext, Droppable, Draggable, type DropResult } from '@hello-pangea/dnd'
import { cn } from '@/lib/utils'
import { TaskCard } from './task-card'
import { CreateTaskDialog } from './create-task-dialog'
import { EditTaskDialog } from './edit-task-dialog'
import { updateTaskStatus } from '@/app/(dashboard)/tasks/actions'
import { TASK_CATEGORY } from '@/lib/constants'
import type { Task, TaskStats } from '@/lib/types'
import { toast } from 'sonner'
import {
  Plus,
  Search,
  LayoutGrid,
  List,
  ChevronDown,
  ChevronRight,
} from 'lucide-react'

/* ── Column config ────────────────────────────────────── */

const COLUMNS = [
  { status: 'To Do', label: 'To Do', color: 'bg-zinc-100 text-zinc-700', headerBorder: 'border-t-zinc-400' },
  { status: 'In Progress', label: 'In Progress', color: 'bg-blue-100 text-blue-700', headerBorder: 'border-t-blue-500' },
  { status: 'Waiting', label: 'Waiting', color: 'bg-amber-100 text-amber-700', headerBorder: 'border-t-amber-500' },
  { status: 'Done', label: 'Done', color: 'bg-emerald-100 text-emerald-700', headerBorder: 'border-t-emerald-500' },
] as const

/* ── Stat card ────────────────────────────────────────── */

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="bg-white rounded-lg border p-4 flex-1 min-w-[120px]">
      <p className={cn('text-2xl font-semibold', color)}>{value}</p>
      <p className="text-xs text-muted-foreground mt-1">{label}</p>
    </div>
  )
}

/* ── Filter bar ───────────────────────────────────────── */

interface Filters {
  assignee: string
  category: string
  priority: string
  search: string
}

function FilterBar({
  filters,
  onChange,
  viewMode,
  onViewChange,
  onCreateTask,
}: {
  filters: Filters
  onChange: (f: Filters) => void
  viewMode: 'kanban' | 'list'
  onViewChange: (v: 'kanban' | 'list') => void
  onCreateTask: () => void
}) {
  return (
    <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
      <div className="flex flex-wrap items-center gap-2">
        {/* Assignee */}
        <select
          value={filters.assignee}
          onChange={e => onChange({ ...filters, assignee: e.target.value })}
          className="px-3 py-1.5 rounded-lg border bg-white text-sm"
        >
          <option value="">All Assignees</option>
          <option value="Antonio">Antonio</option>
          <option value="Luca">Luca</option>
        </select>

        {/* Category */}
        <select
          value={filters.category}
          onChange={e => onChange({ ...filters, category: e.target.value })}
          className="px-3 py-1.5 rounded-lg border bg-white text-sm"
        >
          <option value="">All Categories</option>
          {TASK_CATEGORY.map(c => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>

        {/* Priority */}
        <select
          value={filters.priority}
          onChange={e => onChange({ ...filters, priority: e.target.value })}
          className="px-3 py-1.5 rounded-lg border bg-white text-sm"
        >
          <option value="">All Priorities</option>
          <option value="Urgent">Urgent</option>
          <option value="High">High</option>
          <option value="Normal">Normal</option>
          <option value="Low">Low</option>
        </select>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search tasks..."
            value={filters.search}
            onChange={e => onChange({ ...filters, search: e.target.value })}
            className="pl-8 pr-3 py-1.5 rounded-lg border bg-white text-sm w-48"
          />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={onCreateTask}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-zinc-900 text-white hover:bg-zinc-800 transition-colors"
        >
          <Plus className="h-3.5 w-3.5" />
          New Task
        </button>
        <button
          onClick={() => onViewChange('kanban')}
          className={cn(
            'p-1.5 rounded-lg transition-colors',
            viewMode === 'kanban' ? 'bg-zinc-900 text-white' : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'
          )}
          title="Kanban view"
        >
          <LayoutGrid className="h-4 w-4" />
        </button>
        <button
          onClick={() => onViewChange('list')}
          className={cn(
            'p-1.5 rounded-lg transition-colors',
            viewMode === 'list' ? 'bg-zinc-900 text-white' : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'
          )}
          title="List view"
        >
          <List className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}

/* ── List View (legacy) ───────────────────────────────── */

function ListView({
  columns,
  today,
  onEdit,
}: {
  columns: { status: string; items: Task[] }[]
  today: string
  onEdit: (t: Task) => void
}) {
  return (
    <div className="space-y-2">
      {columns.map(col => (
        <ListSection key={col.status} column={col} today={today} onEdit={onEdit} />
      ))}
    </div>
  )
}

function ListSection({
  column,
  today,
  onEdit,
}: {
  column: { status: string; items: Task[] }
  today: string
  onEdit: (t: Task) => void
}) {
  const cfg = COLUMNS.find(c => c.status === column.status)
  const [open, setOpen] = useState(column.status !== 'Done')

  return (
    <div>
      <button onClick={() => setOpen(!open)} className="flex items-center gap-2 w-full py-3 text-left">
        {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
        <span className="font-semibold text-sm uppercase tracking-wide">{column.status}</span>
        <span className={cn('text-xs font-medium px-2 py-0.5 rounded-full ml-1', cfg?.color ?? 'bg-zinc-100 text-zinc-700')}>
          {column.items.length}
        </span>
      </button>
      {open && (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 pb-4">
          {column.items.length === 0 ? (
            <p className="text-sm text-muted-foreground col-span-full pl-6">Nessun task</p>
          ) : (
            column.items.map(t => (
              <TaskCard key={t.id} task={t} today={today} onEdit={onEdit} />
            ))
          )}
        </div>
      )}
    </div>
  )
}

/* ── Kanban View with DnD ─────────────────────────────── */

function KanbanView({
  columns,
  today,
  onEdit,
  allTasks,
  setAllTasks,
}: {
  columns: { status: string; items: Task[] }[]
  today: string
  onEdit: (t: Task) => void
  allTasks: Task[]
  setAllTasks: (tasks: Task[]) => void
}) {
  const [, startTransition] = useTransition()
  const [doneExpanded, setDoneExpanded] = useState(false)

  function handleDragEnd(result: DropResult) {
    if (!result.destination) return
    const srcStatus = result.source.droppableId
    const dstStatus = result.destination.droppableId
    if (srcStatus === dstStatus && result.source.index === result.destination.index) return

    // Find the dragged task
    const draggedTask = allTasks.find(t => t.id === result.draggableId)
    if (!draggedTask) return

    // Optimistic update
    const updated = allTasks.map(t =>
      t.id === result.draggableId ? { ...t, status: dstStatus, updated_at: new Date().toISOString() } : t
    )
    setAllTasks(updated)

    // Persist
    if (srcStatus !== dstStatus) {
      startTransition(async () => {
        const res = await updateTaskStatus(draggedTask.id, dstStatus, draggedTask.updated_at)
        if (res.success) {
          toast.success(`Task spostato in "${dstStatus}"`, { description: draggedTask.task_title })
        } else {
          toast.error(res.error ?? 'Errore nello spostamento')
          // Revert
          setAllTasks(allTasks)
        }
      })
    }
  }

  return (
    <DragDropContext onDragEnd={handleDragEnd}>
      <div className="flex flex-col md:flex-row gap-4 overflow-x-auto pb-4">
        {columns.map(col => {
          const cfg = COLUMNS.find(c => c.status === col.status)!
          const isDone = col.status === 'Done'
          const visibleItems = isDone && !doneExpanded ? col.items.slice(0, 10) : col.items

          return (
            <div key={col.status} className="w-full md:w-80 md:flex-shrink-0">
              {/* Column header */}
              <div className={cn('rounded-t-lg border-t-4 bg-white border border-b-0 px-3 py-2', cfg.headerBorder)}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-xs uppercase tracking-wide">{cfg.label}</span>
                    <span className={cn('text-xs font-medium px-2 py-0.5 rounded-full', cfg.color)}>
                      {col.items.length}
                    </span>
                  </div>
                  {isDone && col.items.length > 10 && (
                    <button
                      onClick={() => setDoneExpanded(!doneExpanded)}
                      className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                    >
                      {doneExpanded ? 'Show less' : `Show all (${col.items.length})`}
                    </button>
                  )}
                </div>
              </div>

              {/* Droppable area */}
              <Droppable droppableId={col.status}>
                {(provided, snapshot) => (
                  <div
                    ref={provided.innerRef}
                    {...provided.droppableProps}
                    className={cn(
                      'space-y-2 min-h-[80px] rounded-b-lg border border-t-0 bg-zinc-50/50 p-2 transition-colors',
                      isDone ? 'max-h-[50vh] overflow-y-auto' : 'max-h-[70vh] overflow-y-auto',
                      snapshot.isDraggingOver && 'bg-blue-50 ring-2 ring-blue-200'
                    )}
                  >
                    {visibleItems.map((task, index) => (
                      <Draggable key={task.id} draggableId={task.id} index={index}>
                        {(provided, snapshot) => (
                          <div
                            ref={provided.innerRef}
                            {...provided.draggableProps}
                            {...provided.dragHandleProps}
                            className={cn(snapshot.isDragging && 'opacity-90 rotate-1 shadow-lg')}
                          >
                            <TaskCard task={task} today={today} onEdit={onEdit} />
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

/* ── Main Component ───────────────────────────────────── */

export interface TaskKanbanProps {
  tasks: Task[]
  stats: TaskStats
  today: string
}

export function TaskKanban({ tasks: initialTasks, stats, today }: TaskKanbanProps) {
  const [allTasks, setAllTasks] = useState(initialTasks)
  const [viewMode, setViewMode] = useState<'kanban' | 'list'>('kanban')
  const [showCreate, setShowCreate] = useState(false)
  const [editingTask, setEditingTask] = useState<Task | null>(null)
  const [filters, setFilters] = useState<Filters>({
    assignee: '',
    category: '',
    priority: '',
    search: '',
  })

  // Apply filters
  const filteredTasks = useMemo(() => {
    return allTasks.filter(t => {
      if (filters.assignee && t.assigned_to !== filters.assignee) return false
      if (filters.category && t.category !== filters.category) return false
      if (filters.priority && t.priority !== filters.priority) return false
      if (filters.search) {
        const q = filters.search.toLowerCase()
        const matchTitle = t.task_title.toLowerCase().includes(q)
        const matchCompany = t.company_name?.toLowerCase().includes(q)
        if (!matchTitle && !matchCompany) return false
      }
      return true
    })
  }, [allTasks, filters])

  // Build columns from filtered tasks
  const columns = useMemo(() => {
    return COLUMNS.map(col => ({
      status: col.status,
      items: filteredTasks
        .filter(t => t.status === col.status)
        .sort((a, b) => {
          // Sort by priority weight then due date
          const pw: Record<string, number> = { Urgent: 0, High: 1, Normal: 2, Low: 3 }
          const pa = pw[a.priority] ?? 2
          const pb = pw[b.priority] ?? 2
          if (pa !== pb) return pa - pb
          if (a.due_date && b.due_date) return a.due_date.localeCompare(b.due_date)
          if (a.due_date) return -1
          if (b.due_date) return 1
          return 0
        }),
    }))
  }, [filteredTasks])

  return (
    <div className="space-y-6">
      {/* Stats */}
      <div className="flex gap-3 flex-wrap">
        <StatCard label="Active Total" value={stats.total} color="text-foreground" />
        <StatCard label="Urgent" value={stats.urgent} color="text-red-600" />
        <StatCard label="Waiting" value={stats.waiting} color="text-amber-600" />
        <StatCard label="Overdue" value={stats.overdue} color="text-red-600" />
        <StatCard label="In Progress" value={stats.inProgress} color="text-blue-600" />
      </div>

      {/* Filter bar */}
      <FilterBar
        filters={filters}
        onChange={setFilters}
        viewMode={viewMode}
        onViewChange={setViewMode}
        onCreateTask={() => setShowCreate(true)}
      />

      {/* Content */}
      {viewMode === 'kanban' ? (
        <KanbanView
          columns={columns}
          today={today}
          onEdit={setEditingTask}
          allTasks={allTasks}
          setAllTasks={setAllTasks}
        />
      ) : (
        <ListView columns={columns} today={today} onEdit={setEditingTask} />
      )}

      {/* Dialogs */}
      <CreateTaskDialog open={showCreate} onClose={() => setShowCreate(false)} />
      {editingTask && (
        <EditTaskDialog
          task={editingTask}
          open={!!editingTask}
          onClose={() => setEditingTask(null)}
        />
      )}
    </div>
  )
}
