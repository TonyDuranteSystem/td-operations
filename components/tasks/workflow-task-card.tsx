'use client'

import { useState, useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ChevronDown, Clock, MoreHorizontal } from 'lucide-react'
import { ChatWithClientButton } from '@/components/tasks/task-card'
import { cn } from '@/lib/utils'
import { STATUS_COLORS } from '@/lib/constants'
import { parseWorkflowSnapshot } from '@/lib/tasks/workflow-snapshot-schema'
import { filterActionsByRole, filterActionsByStage, splitPrimary } from '@/lib/tasks/workflow-task-card-logic'
import { ActionConfirmModal } from '@/components/tasks/action-confirm-modal'
import { WorkflowErrorBoundary } from '@/components/tasks/workflow-error-boundary'
import { getAttachmentTemplate } from '@/components/tasks/attachment-templates'
import { SLA_STATE, SLA_META_KEYS } from '@/lib/tasks/sla-eligibility'
import type {
  CrmRole,
  TaskStatus,
  WorkflowActionDefinition,
  WorkflowSnapshot,
} from '@/lib/tasks/types'
import type { Task } from '@/lib/types'
import { differenceInDays, parseISO } from 'date-fns'

/**
 * WorkflowTaskCard — renders a workflow-aware task.
 *
 * Mounted by TaskCard when task.workflow_snapshot is non-null. Plain tasks
 * continue to use the legacy TaskCard render path so the no-workflow case
 * stays zero-cost.
 *
 * Layout:
 *   • Title + workflow_state badge (from task_meta.workflow_state when present,
 *     else task.status)
 *   • Attachment slot (resolved from workflow.attachment_template)
 *   • Action bar:
 *       desktop: primary action + secondary buttons inline
 *       mobile : primary action + overflow menu (•••)
 *   • Last error banner if task_meta.last_error is set (failure recovery surface)
 *
 * Every action button opens ActionConfirmModal which shows a live preview from
 * the dispatcher in mode='preview' before committing.
 *
 * Permission filter: actions whose permission.role_in does not include the
 * current viewer's role are hidden. Currently the prop is required; future
 * integration with the dashboard auth context will inject it automatically.
 */

function getDaysLabel(dueDate: string, today: string): { text: string; overdue: boolean } {
  const due = parseISO(dueDate)
  const now = parseISO(today)
  const diff = differenceInDays(due, now)
  if (diff < 0) return { text: `Overdue ${Math.abs(diff)}d`, overdue: true }
  if (diff === 0) return { text: 'Due today', overdue: false }
  if (diff === 1) return { text: 'Due tomorrow', overdue: false }
  return { text: `Due in ${diff}d`, overdue: false }
}

interface Props {
  task: Task
  today: string
  /** Current viewer's CRM role; used to filter actions. */
  role: CrmRole
}

export function WorkflowTaskCard({ task, today, role }: Props) {
  return (
    <WorkflowErrorBoundary>
      <WorkflowTaskCardInner task={task} today={today} role={role} />
    </WorkflowErrorBoundary>
  )
}

function WorkflowTaskCardInner({ task, today, role }: Props) {
  const queryClient = useQueryClient()
  const [openAction, setOpenAction] = useState<WorkflowActionDefinition | null>(null)
  const [overflowOpen, setOverflowOpen] = useState(false)

  // Parse + validate the pinned snapshot. Throws → caught by the boundary above.
  const snapshot: WorkflowSnapshot = useMemo(
    () => parseWorkflowSnapshot(task.workflow_snapshot),
    [task.workflow_snapshot],
  )

  // Current SD stage from task_meta (Slice 9). Seeded by dispatcher at
  // workflow spawn (sd_created trigger), updated by chain.advance_sd_stage
  // after each transition via task_meta_patch. Used to filter action buttons
  // via visible_when.sd_stage so Luca only sees buttons relevant to the
  // current stage of a multi-stage workflow (formation/closure/onboarding).
  const currentSdStage =
    task.task_meta && typeof task.task_meta === 'object'
      ? ((task.task_meta as Record<string, unknown>).sd_stage as string | undefined)
      : undefined

  const visibleActions = useMemo(
    () => filterActionsByStage(filterActionsByRole(snapshot.actions, role), currentSdStage),
    [snapshot.actions, role, currentSdStage],
  )
  const { primary, rest } = useMemo(() => splitPrimary(visibleActions), [visibleActions])

  const AttachmentTemplate = getAttachmentTemplate(snapshot.attachment_template)
  const workflowState =
    task.task_meta && typeof task.task_meta === 'object'
      ? (task.task_meta as Record<string, unknown>).workflow_state
      : null
  const stateLabel = typeof workflowState === 'string' && workflowState ? workflowState : task.status

  // Slice 10: SLA badge sourced from task_meta.sla_state (set by the
  // /api/cron/workflow-sla-check cron). 'warn' = yellow, 'escalated' = red.
  // Other values (or absent) → no badge.
  const slaState =
    task.task_meta && typeof task.task_meta === 'object'
      ? (task.task_meta as Record<string, unknown>)[SLA_META_KEYS.state]
      : undefined
  const slaTier: typeof SLA_STATE.WARN | typeof SLA_STATE.ESCALATED | null =
    slaState === SLA_STATE.WARN
      ? SLA_STATE.WARN
      : slaState === SLA_STATE.ESCALATED
        ? SLA_STATE.ESCALATED
        : null

  const lastError =
    task.task_meta && typeof task.task_meta === 'object'
      ? ((task.task_meta as Record<string, unknown>).last_error as
          | { code?: string; message?: string }
          | undefined)
      : undefined

  const dueInfo = task.due_date ? getDaysLabel(task.due_date, today) : null

  const onActionCompleted = () => {
    // Invalidate the per-thread tasks query so the panel refreshes.
    queryClient.invalidateQueries({ queryKey: ['portal-chat-thread-tasks'] }).catch(() => {})
  }

  return (
    <div
      className={cn(
        'bg-white rounded-lg border p-4',
        dueInfo?.overdue && 'border-red-200 bg-red-50/50',
      )}
    >
      {/* Top row: company + status badge */}
      <div className="flex items-start justify-between gap-2 mb-1">
        <div className="flex items-center gap-2 flex-wrap">
          {task.company_name && (
            <span className="text-xs font-medium text-muted-foreground">{task.company_name}</span>
          )}
          <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 border border-indigo-100">
            {snapshot.label_admin}
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {dueInfo?.overdue && (
            <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-red-100 text-red-700">
              OVERDUE
            </span>
          )}
          <span
            className={cn(
              'text-xs px-1.5 py-0.5 rounded',
              STATUS_COLORS[task.priority] ?? 'bg-zinc-100 text-zinc-600',
            )}
          >
            {task.priority}
          </span>
        </div>
      </div>

      {/* Title */}
      <div className="text-sm font-medium leading-snug mb-2 line-clamp-2 text-zinc-900">
        {task.task_title}
      </div>

      {/* Attachment template slot */}
      {AttachmentTemplate && (
        <div className="mb-3">
          <AttachmentTemplate taskMeta={task.task_meta ?? null} />
        </div>
      )}

      {/* Last error banner (failure recovery surface) */}
      {lastError && (
        <div className="mb-3 px-2 py-1.5 rounded bg-red-50 border border-red-200 text-xs text-red-800">
          <div className="font-medium">
            Last action failed{lastError.code ? ` (${lastError.code})` : ''}
          </div>
          {lastError.message && <div className="opacity-80">{lastError.message}</div>}
        </div>
      )}

      {/* Bottom row: assignee + state + actions */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="font-medium text-foreground/70">{task.assigned_to}</span>
          <span className="inline-flex items-center gap-1">{stateLabel}</span>
          {slaTier && (
            <span
              title={
                slaTier === SLA_STATE.WARN
                  ? 'SLA warning — task is overdue for action'
                  : 'SLA escalated — past the escalation threshold'
              }
              className={cn(
                'text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded font-semibold',
                slaTier === SLA_STATE.WARN
                  ? 'bg-yellow-100 text-yellow-800 border border-yellow-200'
                  : 'bg-red-100 text-red-700 border border-red-200',
              )}
            >
              SLA {slaTier === SLA_STATE.WARN ? 'WARN' : 'ESCALATED'}
            </span>
          )}
          {dueInfo && (
            <span
              className={cn(
                'inline-flex items-center gap-1',
                dueInfo.overdue ? 'text-red-600 font-medium' : '',
              )}
            >
              <Clock className="h-3 w-3" />
              {dueInfo.text}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1">
          <ChatWithClientButton accountId={task.account_id} contactId={task.contact_id} />
          {primary && (
            <button
              type="button"
              onClick={() => setOpenAction(primary)}
              className="px-2.5 py-1 text-xs font-medium rounded bg-blue-600 text-white hover:bg-blue-700"
            >
              {primary.label_admin}
            </button>
          )}
          {/* Desktop: show rest inline. Mobile: hide all but the first under overflow. */}
          {rest.length > 0 && (
            <>
              <div className="hidden sm:flex items-center gap-1">
                {rest.map((a) => (
                  <button
                    key={a.slug}
                    type="button"
                    onClick={() => setOpenAction(a)}
                    className="px-2 py-1 text-xs rounded border hover:bg-zinc-50 text-zinc-700"
                  >
                    {a.label_admin}
                  </button>
                ))}
              </div>
              <div className="relative sm:hidden">
                <button
                  type="button"
                  onClick={() => setOverflowOpen((v) => !v)}
                  className="p-1.5 rounded hover:bg-zinc-100 text-zinc-600"
                  aria-label="More actions"
                  aria-expanded={overflowOpen}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </button>
                {overflowOpen && (
                  <div className="absolute right-0 bottom-full mb-1 z-10 min-w-[160px] bg-white border rounded-lg shadow-lg py-1">
                    {rest.map((a) => (
                      <button
                        key={a.slug}
                        type="button"
                        onClick={() => {
                          setOpenAction(a)
                          setOverflowOpen(false)
                        }}
                        className="block w-full text-left px-3 py-1.5 text-xs hover:bg-zinc-50 text-zinc-700 inline-flex items-center gap-1"
                      >
                        <ChevronDown className="h-3 w-3 opacity-0" />
                        {a.label_admin}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {openAction && (
        <ActionConfirmModal
          open={!!openAction}
          onClose={() => setOpenAction(null)}
          onCompleted={onActionCompleted}
          taskId={task.id}
          action={openAction}
          expectedStatus={task.status as TaskStatus}
          contextLine={`${snapshot.label_admin} — ${task.company_name ?? task.task_title}`}
        />
      )}
    </div>
  )
}
