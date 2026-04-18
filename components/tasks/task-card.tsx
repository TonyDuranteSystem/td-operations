'use client'

import { useTransition } from 'react'
import { Check, RotateCw, ChevronUp, ChevronDown, Clock, Paperclip, ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils'
import { STATUS_COLORS } from '@/lib/constants'
import { updateTaskStatus, updateTaskPriority, updateTaskAssignee } from '@/app/(dashboard)/tasks/actions'
import { TaskRowActions } from '@/components/tasks/task-row-actions'
import type { Task } from '@/lib/types'
import { differenceInDays, parseISO } from 'date-fns'
import { toast } from 'sonner'

function getDaysLabel(dueDate: string, today: string): { text: string; overdue: boolean } {
  const due = parseISO(dueDate)
  const now = parseISO(today)
  const diff = differenceInDays(due, now)
  if (diff < 0) return { text: `Overdue ${Math.abs(diff)}d`, overdue: true }
  if (diff === 0) return { text: 'Due today', overdue: false }
  if (diff === 1) return { text: 'Due tomorrow', overdue: false }
  return { text: `Due in ${diff}d`, overdue: false }
}

function isFollowUp(task: Task, today: string): boolean {
  if (task.status !== 'Waiting') return false
  const updated = parseISO(task.updated_at)
  const now = parseISO(today)
  return differenceInDays(now, updated) >= 5
}

export function TaskCard({ task, today, onEdit }: { task: Task; today: string; onEdit?: (task: Task) => void }) {
  const [isPending, startTransition] = useTransition()

  const dueInfo = task.due_date ? getDaysLabel(task.due_date, today) : null
  const followUp = isFollowUp(task, today)

  const handleComplete = () => {
    startTransition(async () => {
      const result = await updateTaskStatus(task.id, 'Done', task.updated_at)
      if (!result.success) toast.error(result.error)
    })
  }

  const handleReassign = () => {
    const next = task.assigned_to === 'Luca' ? 'Antonio' : 'Luca'
    startTransition(async () => {
      const result = await updateTaskAssignee(task.id, next, task.updated_at)
      if (!result.success) toast.error(result.error)
    })
  }

  const handlePriorityUp = () => {
    const order = ['Low', 'Normal', 'High', 'Urgent']
    const idx = order.indexOf(task.priority)
    if (idx < order.length - 1) {
      startTransition(async () => {
        const result = await updateTaskPriority(task.id, order[idx + 1], task.updated_at)
        if (!result.success) toast.error(result.error)
      })
    }
  }

  const handlePriorityDown = () => {
    const order = ['Low', 'Normal', 'High', 'Urgent']
    const idx = order.indexOf(task.priority)
    if (idx > 0) {
      startTransition(async () => {
        const result = await updateTaskPriority(task.id, order[idx - 1], task.updated_at)
        if (!result.success) toast.error(result.error)
      })
    }
  }

  return (
    <div
      className={cn(
        'bg-white rounded-lg border p-4 transition-opacity',
        isPending && 'opacity-50',
        dueInfo?.overdue && 'border-red-200 bg-red-50/50'
      )}
    >
      {/* Top row: company + badges */}
      <div className="flex items-start justify-between gap-2 mb-1">
        <div className="flex items-center gap-2 flex-wrap">
          {task.company_name && (
            <span className="text-xs font-medium text-muted-foreground">{task.company_name}</span>
          )}
          {task.category && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-600">
              {task.category}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {dueInfo?.overdue && (
            <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-red-100 text-red-700">
              SCADUTO
            </span>
          )}
          {followUp && (
            <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">
              FOLLOW UP
            </span>
          )}
          <span className={cn('text-xs px-1.5 py-0.5 rounded', STATUS_COLORS[task.priority] ?? 'bg-zinc-100 text-zinc-600')}>
            {task.priority}
          </span>
        </div>
      </div>

      {/* Title */}
      <button
        type="button"
        onClick={() => onEdit?.(task)}
        className="text-sm font-medium leading-snug mb-2 line-clamp-2 text-left hover:underline cursor-pointer"
      >
        {task.task_title}
      </button>

      {/* Attachments — rendered as clickable chips with filename + external-link icon.
          Used for ITIN rescue PDFs (W-7, 1040-NR, Schedule OI) and any task that
          needs Luca/staff to download/print a file. */}
      {task.attachments && task.attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {task.attachments.map((att, i) => (
            <a
              key={`${att.url}-${i}`}
              href={att.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-blue-50 text-blue-700 text-xs hover:bg-blue-100 transition-colors"
              title={att.name}
            >
              <Paperclip className="h-3 w-3 shrink-0" />
              <span className="truncate max-w-[160px]">{att.name}</span>
              <ExternalLink className="h-2.5 w-2.5 shrink-0 opacity-60" />
            </a>
          ))}
        </div>
      )}

      {/* Bottom row: assignee + SLA + actions */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="font-medium text-foreground/70">{task.assigned_to}</span>
          <span className={cn('inline-flex items-center gap-1', STATUS_COLORS[task.status] ?? '', 'bg-transparent')}>
            {task.status}
          </span>
          {dueInfo && (
            <span className={cn('inline-flex items-center gap-1', dueInfo.overdue ? 'text-red-600 font-medium' : '')}>
              <Clock className="h-3 w-3" />
              {dueInfo.text}
            </span>
          )}
        </div>

        {/* Quick actions */}
        <div className="flex items-center gap-1">
          <button
            onClick={handleComplete}
            disabled={isPending}
            className="p-1.5 rounded hover:bg-emerald-50 text-muted-foreground hover:text-emerald-600 transition-colors"
            title="Segna completato"
          >
            <Check className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={handleReassign}
            disabled={isPending}
            className="p-1.5 rounded hover:bg-blue-50 text-muted-foreground hover:text-blue-600 transition-colors"
            title={`Riassegna a ${task.assigned_to === 'Luca' ? 'Antonio' : 'Luca'}`}
          >
            <RotateCw className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={handlePriorityUp}
            disabled={isPending || task.priority === 'Urgent'}
            className="p-1.5 rounded hover:bg-orange-50 text-muted-foreground hover:text-orange-600 transition-colors disabled:opacity-30"
            title="Aumenta priorita"
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={handlePriorityDown}
            disabled={isPending || task.priority === 'Low'}
            className="p-1.5 rounded hover:bg-zinc-100 text-muted-foreground hover:text-zinc-600 transition-colors disabled:opacity-30"
            title="Diminuisci priorita"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          <TaskRowActions task={task} />
        </div>
      </div>
    </div>
  )
}
