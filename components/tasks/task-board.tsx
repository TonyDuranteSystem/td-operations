'use client'

import { useState } from 'react'
import { ChevronDown, ChevronRight, AlertTriangle, Loader2, Clock, AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { TaskCard } from './task-card'
import type { GroupedTasks, TaskStats } from '@/lib/types'

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
  return (
    <div className="space-y-6">
      {/* Summary bar */}
      <div className="flex gap-3 flex-wrap">
        <StatCard label="Totale Attivi" value={stats.total} color="text-foreground" />
        <StatCard label="Urgenti" value={stats.urgent} color="text-red-600" />
        <StatCard label="In Attesa" value={stats.waiting} color="text-amber-600" />
        <StatCard label="Scaduti" value={stats.overdue} color="text-red-600" />
        <StatCard label="In Corso" value={stats.inProgress} color="text-blue-600" />
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
              <TaskCard key={task.id} task={task} today={today} />
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
              <TaskCard key={task.id} task={task} today={today} />
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
              <TaskCard key={task.id} task={task} today={today} />
            ))
          )}
        </Section>
      </div>
    </div>
  )
}
