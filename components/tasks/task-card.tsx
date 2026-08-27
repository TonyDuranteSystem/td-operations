'use client'

import { useTransition } from 'react'
import Link from 'next/link'
import { Check, RotateCw, ChevronUp, ChevronDown, Clock, Paperclip, ExternalLink, MessageSquare } from 'lucide-react'
import { cn } from '@/lib/utils'
import { STATUS_COLORS } from '@/lib/constants'
import { updateTaskStatus, updateTaskPriority, updateTaskAssignee } from '@/app/(dashboard)/tasks/actions'
import { TaskRowActions } from '@/components/tasks/task-row-actions'
import { FastTooltip } from '@/components/ui/fast-tooltip'
import { WorkflowTaskCard } from '@/components/tasks/workflow-task-card'
import type { Task } from '@/lib/types'
import type { CrmRole } from '@/lib/tasks/types'
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

/**
 * Router component. Delegates workflow-driven tasks to WorkflowTaskCard,
 * everything else to the legacy LegacyTaskCard. Keeping the routing out of
 * the inner component avoids violating React's hooks-order rules.
 */
export function TaskCard(props: {
  task: Task
  today: string
  onEdit?: (task: Task) => void
  /**
   * Viewer's CRM role. Defaults to 'admin' so the workflow-aware render path
   * shows all actions on dashboards that haven't yet plumbed the auth context
   * down. The dispatcher route enforces RBAC server-side regardless.
   */
  role?: CrmRole
}) {
  if (props.task.workflow_snapshot && typeof props.task.workflow_snapshot === 'object') {
    return <WorkflowTaskCard task={props.task} today={props.today} role={props.role ?? 'admin'} />
  }
  return <LegacyTaskCard task={props.task} today={props.today} onEdit={props.onEdit} />
}

function LegacyTaskCard({ task, today, onEdit }: { task: Task; today: string; onEdit?: (task: Task) => void }) {
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
            <FastTooltip key={`${att.url}-${i}`} label={att.name}>
              <a
                href={att.url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-blue-50 text-blue-700 text-xs hover:bg-blue-100 transition-colors"
                aria-label={att.name}
              >
                <Paperclip className="h-3 w-3 shrink-0" />
                <span className="truncate max-w-[160px]">{att.name}</span>
                <ExternalLink className="h-2.5 w-2.5 shrink-0 opacity-60" />
              </a>
            </FastTooltip>
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
          <FastTooltip label="Segna completato">
            <button
              onClick={handleComplete}
              disabled={isPending}
              className="p-1.5 rounded hover:bg-emerald-50 text-muted-foreground hover:text-emerald-600 transition-colors"
              aria-label="Segna completato"
            >
              <Check className="h-3.5 w-3.5" />
            </button>
          </FastTooltip>
          <FastTooltip label={`Riassegna a ${task.assigned_to === 'Luca' ? 'Antonio' : 'Luca'}`}>
            <button
              onClick={handleReassign}
              disabled={isPending}
              className="p-1.5 rounded hover:bg-blue-50 text-muted-foreground hover:text-blue-600 transition-colors"
              aria-label={`Riassegna a ${task.assigned_to === 'Luca' ? 'Antonio' : 'Luca'}`}
            >
              <RotateCw className="h-3.5 w-3.5" />
            </button>
          </FastTooltip>
          <FastTooltip label="Aumenta priorita">
            <button
              onClick={handlePriorityUp}
              disabled={isPending || task.priority === 'Urgent'}
              className="p-1.5 rounded hover:bg-orange-50 text-muted-foreground hover:text-orange-600 transition-colors disabled:opacity-30"
              aria-label="Aumenta priorita"
            >
              <ChevronUp className="h-3.5 w-3.5" />
            </button>
          </FastTooltip>
          <FastTooltip label="Diminuisci priorita">
            <button
              onClick={handlePriorityDown}
              disabled={isPending || task.priority === 'Low'}
              className="p-1.5 rounded hover:bg-zinc-100 text-muted-foreground hover:text-zinc-600 transition-colors disabled:opacity-30"
              aria-label="Diminuisci priorita"
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
          </FastTooltip>
          <ChatWithClientButton accountId={task.account_id} contactId={task.contact_id} />
          <TaskRowActions task={task} />
        </div>
      </div>
    </div>
  )
}

/**
 * Small icon button that deep-links to /portal-chats with the task's account
 * (or contact) thread pre-selected. Added 2026-05-18 per Antonio: every task
 * should have a 1-click affordance to chat with the client about THAT thing.
 *
 * Renders nothing when the task has neither account_id nor contact_id (no
 * thread to open). The portal-chats page reads `?account=<id>` to scroll its
 * sidebar to that thread; falls back to contact-only when account is absent.
 */
function ChatWithClientButton({
  accountId,
  contactId,
}: {
  accountId?: string | null
  contactId?: string | null
}) {
  if (!accountId && !contactId) return null
  const href = accountId
    ? `/portal-chats?account=${accountId}`
    : `/portal-chats?contact=${contactId}`
  return (
    <Link
      href={href}
      title="Chat with client about this"
      className="p-1.5 rounded hover:bg-blue-50 text-muted-foreground hover:text-blue-600 transition-colors"
    >
      <MessageSquare className="h-3.5 w-3.5" />
    </Link>
  )
}

export { ChatWithClientButton }
