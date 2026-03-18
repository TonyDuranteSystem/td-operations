'use client'

import { useState } from 'react'
import { ChevronDown, ChevronRight, AlertTriangle, Loader2, Clock, AlertCircle, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { TaskCard } from './task-card'
import { CreateTaskDialog } from './create-task-dialog'
import { EditTaskDialog } from './edit-task-dialog'
import type { Task, GroupedTasks, TaskStats } from '@/lib/types'

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="bg-white rounded-lg border p-4 flex-1 min-w-[120px]">
      <p className={cn('text-2xl font-semibold', color)}>{value}</p>
      <p className="text-xs text-muted-foreground mt-1">{label}</p>
    </div>
  )
}

function Section({
  title,
  icon,
  count,
  color,
  children,
  defaultOpen = true,
}: {
  title: string
  icon: React.ReactNode
  count: number
  color: string
  children: React.ReactNode
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 w-full py-3 text-left"
      >
        {open ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        )}
        <span className="flex items-center gap-2">
          {icon}
          <span className="font-semibold text-sm uppercase tracking-wide">{title}</span>
        </span>
        <span className={cn('text-xs font-medium px-2 py-0.5 rounded-full ml-1', color)}>
          {count}
        </span>
      </button>
      {open && (
        <div className="space-y-2 pb-4">
          {children}
        </div>
      )}
    </div>
  )
}

export function TaskBoard({
  tasks,
  stats,
  today,
}: {
  tasks: GroupedTasks
  stats: TaskStats
  today: string
}) {
  const [showCreate, setShowCreate] = useState(false)
  const [editingTask, setEditingTask] = useState<Task | null>(null)

  return (
    <div className="space-y-6">
      {/* Summary bar + New Task button */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex gap-3 flex-wrap flex-1">
        <StatCard label="Totale Attivi" value={stats.total} color="text-foreground" />
        <StatCard label="Urgenti" value={stats.urgent} color="text-red-600" />
        <StatCard label="In Attesa" value={stats.waiting} color="text-amber-600" />
        <StatCard label="Scaduti" value={stats.overdue} color="text-red-600" />
        <StatCard label="In Corso" value={stats.inProgress} color="text-blue-600" />
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 px-4 py-2 text-sm bg-zinc-900 text-white rounded-md hover:bg-zinc-800 shrink-0"
        >
          <Plus className="h-4 w-4" />
          New Task
        </button>
      </div>

      {/* Sections */}
      <div className="space-y-2">
        <Section
          title="Urgente"
          icon={<AlertTriangle className="h-4 w-4 text-red-500" />}
          count={tasks.urgente.length}
          color="bg-red-100 text-red-700"
        >
          {tasks.urgente.length === 0 ? (
            <p className="text-sm text-muted-foreground pl-6">Nessun task urgente</p>
          ) : (
            tasks.urgente.map(task => (
              <TaskCard key={task.id} task={task} today={today} onEdit={setEditingTask} />
            ))
          )}
        </Section>

        <Section
          title="In Corso"
          icon={<Loader2 className="h-4 w-4 text-blue-500" />}
          count={tasks.inCorso.length}
          color="bg-blue-100 text-blue-700"
        >
          {tasks.inCorso.length === 0 ? (
            <p className="text-sm text-muted-foreground pl-6">Nessun task in corso</p>
          ) : (
            tasks.inCorso.map(task => (
              <TaskCard key={task.id} task={task} today={today} onEdit={setEditingTask} />
            ))
          )}
        </Section>

        <Section
          title="Normale"
          icon={<Clock className="h-4 w-4 text-zinc-500" />}
          count={tasks.normale.length}
          color="bg-zinc-100 text-zinc-700"
          defaultOpen={false}
        >
          {tasks.normale.length === 0 ? (
            <p className="text-sm text-muted-foreground pl-6">Nessun task</p>
          ) : (
            tasks.normale.map(task => (
              <TaskCard key={task.id} task={task} today={today} onEdit={setEditingTask} />
            ))
          )}
        </Section>
      </div>

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
