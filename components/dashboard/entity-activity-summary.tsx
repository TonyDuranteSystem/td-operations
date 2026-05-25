'use client'

/**
 * EntityActivitySummary — a staff-only roll-up of "everything happening" for one
 * entity (a contact, an account, or a partner's underlying contact), shown on
 * that entity's detail page. Three sections, each deep-linking to where you act:
 *   • What's New — unhandled client-action notes (the purple-dot feed)
 *   • To-Do      — open Notification Center cards for this entity
 *   • Workflow   — open workflow tasks for this entity
 *
 * Reuses the SAME staff-only endpoints as the board / portal-chats panels, so the
 * numbers always agree (incl. the P1 snooze filter on To-Do cards). Pass exactly
 * one of accountId / contactId. STAFF-ONLY (the endpoints 403 a client).
 * See sysdoc notification-center-phase2-cards-summary-plan.
 */

import { useMemo } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { Sparkles, ListTodo, GitBranch, ArrowRight, Loader2 } from 'lucide-react'
import { HelpDot } from '@/components/help/help-dot'

interface WhatsNewNote { id: string; text: string; topic: string | null; handled_at: string | null }
interface TodoCard { id: string; label: string | null; action_type: string }
interface WorkflowTask { id: string; task_title: string; status: string; workflow_snapshot: unknown }

export function EntityActivitySummary({
  accountId,
  contactId,
}: {
  accountId?: string | null
  contactId?: string | null
}) {
  const scope = accountId ? `account_id=${accountId}` : contactId ? `contact_id=${contactId}` : null
  const scopeKey = accountId ?? contactId ?? null
  // Deep-link to the portal-chats thread where these items are acted on.
  const threadHref = accountId
    ? `/portal-chats?account=${accountId}`
    : contactId
      ? `/portal-chats?contact=${contactId}`
      : '/portal-chats'

  const { data: notes, isLoading: lN } = useQuery<WhatsNewNote[]>({
    queryKey: ['entity-summary-whatsnew', scopeKey],
    queryFn: () =>
      fetch(`/api/crm/admin-actions/whats-new?notes=true&${scope}`)
        .then((r) => r.json())
        .then((d: { notes?: WhatsNewNote[] }) => d.notes || []),
    enabled: !!scope,
    refetchInterval: 60_000,
  })

  const { data: todos, isLoading: lT } = useQuery<TodoCard[]>({
    queryKey: ['entity-summary-todos', scopeKey],
    queryFn: () =>
      fetch(`/api/crm/admin-actions/message-actions?open=true&${scope}`)
        .then((r) => r.json())
        .then((d: { actions?: TodoCard[] }) => d.actions || []),
    enabled: !!scope,
    refetchInterval: 60_000,
  })

  const { data: tasks, isLoading: lW } = useQuery<WorkflowTask[]>({
    queryKey: ['entity-summary-workflow', scopeKey],
    queryFn: () =>
      fetch(`/api/tasks/by-thread?${scope}`)
        .then((r) => r.json())
        .then((d: { tasks?: WorkflowTask[] }) => (d.tasks || []).filter((t) => t.workflow_snapshot)),
    enabled: !!scope,
    refetchInterval: 60_000,
  })

  const unhandledNotes = useMemo(() => (notes ?? []).filter((n) => !n.handled_at), [notes])
  const openTasks = useMemo(() => (tasks ?? []).filter((t) => t.status !== 'done' && t.status !== 'completed'), [tasks])
  const loading = lN || lT || lW
  const total = unhandledNotes.length + (todos?.length ?? 0) + openTasks.length

  if (!scope) return null

  return (
    <div className="bg-white rounded-lg border p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="flex items-center gap-1 text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Activity &amp; to-dos
          <HelpDot helpKey="widget.activity" />
        </h3>
        <Link href={threadHref} className="flex items-center gap-1 text-[11px] font-medium text-violet-700 hover:text-violet-900">
          Open in chat <ArrowRight className="h-3 w-3" />
        </Link>
      </div>

      {loading ? (
        <div className="flex justify-center py-4"><Loader2 className="h-4 w-4 animate-spin text-zinc-400" /></div>
      ) : total === 0 ? (
        <p className="text-sm text-muted-foreground py-2">Nothing needs attention right now.</p>
      ) : (
        <div className="space-y-3">
          <Section
            icon={<Sparkles className="h-3.5 w-3.5 text-amber-500" />}
            label="What's New"
            count={unhandledNotes.length}
            href={threadHref}
            rows={unhandledNotes.slice(0, 3).map((n) => ({ id: n.id, text: n.text }))}
          />
          <Section
            icon={<ListTodo className="h-3.5 w-3.5 text-violet-500" />}
            label="To-Do"
            count={todos?.length ?? 0}
            href={threadHref}
            rows={(todos ?? []).slice(0, 3).map((t) => ({ id: t.id, text: t.label || '(no description)' }))}
          />
          <Section
            icon={<GitBranch className="h-3.5 w-3.5 text-sky-500" />}
            label="Workflow"
            count={openTasks.length}
            href={threadHref}
            rows={openTasks.slice(0, 3).map((t) => ({ id: t.id, text: t.task_title }))}
          />
        </div>
      )}
    </div>
  )
}

function Section({
  icon,
  label,
  count,
  href,
  rows,
}: {
  icon: React.ReactNode
  label: string
  count: number
  href: string
  rows: Array<{ id: string; text: string }>
}) {
  if (count === 0) return null
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1">
        {icon}
        <span className="text-xs font-semibold text-zinc-700">{label}</span>
        <span className="text-[10px] font-semibold text-zinc-500 bg-zinc-100 rounded-full px-1.5">{count}</span>
      </div>
      <ul className="space-y-0.5 pl-5">
        {rows.map((r) => (
          <li key={r.id} className="text-xs text-zinc-600 truncate">
            <Link href={href} className="hover:text-violet-700 hover:underline">{r.text}</Link>
          </li>
        ))}
        {count > rows.length && (
          <li className="text-[11px] text-zinc-400">
            <Link href={href} className="hover:text-violet-700">+{count - rows.length} more…</Link>
          </li>
        )}
      </ul>
    </div>
  )
}
