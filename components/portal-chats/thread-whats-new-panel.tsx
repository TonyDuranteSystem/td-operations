'use client'

/**
 * ThreadWhatsNewPanel — the "What's New" feed inside /portal-chats for one
 * client: the incoming client-action notes the team must triage. Reads from
 * /api/crm/admin-actions/whats-new?notes=true, which returns only the events
 * turned ON in Board Settings (per-event show/hide) and resolves each note to
 * its event. STAFF-ONLY (system chat-event notes are hidden from the client).
 *
 * Each note: "Open card" opens the SAME dashboard card editor pre-attached to
 * this client; a Handled toggle marks it triaged (drops it off the purple dot).
 * See sysdoc notification-center-workflow-integration-plan.
 */

import { useCallback, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Sparkles, Plus, CheckCircle2, Square, CheckSquare } from 'lucide-react'
import { formatDistanceToNow, format } from 'date-fns'
import { WorkflowTaskCard } from '@/components/tasks/workflow-task-card'
import { CardCreateActions } from '@/components/notifications/card-create-actions'
import { HelpDot } from '@/components/help/help-dot'
import type { Task } from '@/lib/types'

const WHATS_NEW_API = '/api/crm/admin-actions/whats-new'

interface ApiNote {
  id: string
  event_key: string | null
  task_id: string | null
  topic: string | null
  text: string
  /** Suggested next step for "Open card" — resolved server-side (per-event
   *  override from Board Settings → code default). Editable, no longer hardcoded. */
  suggested_step: string
  created_at: string
  handled_at: string | null
  handled_by: string | null
}

export function ThreadWhatsNewPanel({
  accountId,
  contactId,
  cardAccountId,
  onOpenCard,
}: {
  /** Notes/dot SCOPE. Must mirror the conversation-list dot: account-level thread
   *  → its account_id; contact-level thread → null here (so notes load by contact_id).
   *  Do NOT pass the viewed-company fallback here, or contact-only notes that feed
   *  the dot become unreachable and the purple dot never clears. */
  accountId: string | null
  contactId: string | null
  /** Account to attach NEW cards/money-actions to — may be the viewed company even on
   *  a contact-level thread. Defaults to accountId when omitted. */
  cardAccountId?: string | null
  onOpenCard: (note: { noteId: string; label: string }) => void
}) {
  const qc = useQueryClient()
  const [togglingId, setTogglingId] = useState<string | null>(null)
  // How many notes to show. "Load older" raises it; the full history lives in the
  // DB and is never purged, so older items remain reachable on demand.
  const [limit, setLimit] = useState(100)
  const scopeKey = accountId ?? contactId
  const param = accountId ? `account_id=${accountId}` : contactId ? `contact_id=${contactId}` : null

  const { data: notes, isLoading } = useQuery<ApiNote[]>({
    queryKey: ['thread-whats-new', scopeKey, limit],
    queryFn: () =>
      fetch(`${WHATS_NEW_API}?notes=true&${param}&limit=${limit}`)
        .then((r) => r.json())
        .then((d: { notes?: ApiNote[] }) => d.notes || []),
    enabled: !!param,
    refetchInterval: 30_000,
  })

  // Open workflow tasks for this client — used to render the workflow's action
  // buttons + SLA inline on its What's New note. Key matches what
  // WorkflowTaskCard invalidates (['portal-chat-thread-tasks']) so actions refresh.
  const { data: wfTasks } = useQuery<Task[]>({
    queryKey: ['portal-chat-thread-tasks', scopeKey],
    queryFn: () =>
      fetch(`/api/tasks/by-thread?${param}`)
        .then((r) => r.json())
        .then((d: { tasks?: Task[] }) => (d.tasks || []).filter((t) => t.workflow_snapshot)),
    enabled: !!param,
    refetchInterval: 30_000,
  })
  const taskById = useMemo(() => {
    const m = new Map<string, Task>()
    for (const t of wfTasks ?? []) m.set(t.id, t)
    return m
  }, [wfTasks])
  const today = new Date().toISOString().split('T')[0]

  const toggleHandled = useCallback(
    async (note: ApiNote) => {
      setTogglingId(note.id)
      try {
        const res = await fetch(WHATS_NEW_API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message_id: note.id, handled: !note.handled_at }),
        })
        if (!res.ok) {
          const d = await res.json().catch(() => ({}))
          throw new Error(d.error || 'Could not update')
        }
      } finally {
        await qc.invalidateQueries({ queryKey: ['thread-whats-new'] })
        await qc.invalidateQueries({ queryKey: ['portal-chat-whats-new-counts'] })
        setTogglingId(null)
      }
    },
    [qc],
  )

  const open = useCallback(
    (note: ApiNote) => {
      const label = note.suggested_step || note.text
      onOpenCard({ noteId: note.id, label })
    },
    [onOpenCard],
  )

  if (!param) {
    return (
      <div className="flex items-center justify-center py-6">
        <p className="text-sm text-zinc-400">Select a conversation</p>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-4 py-2 bg-amber-50/60 border-b border-amber-100 flex items-center gap-1.5 shrink-0">
        <Sparkles className="h-3.5 w-3.5 text-amber-500" />
        <span className="text-xs font-medium text-amber-700">What&apos;s New — things this client did</span>
        <HelpDot helpKey="whatsnew.feed" />
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {isLoading ? (
          <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-zinc-400" /></div>
        ) : !notes || notes.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <CheckCircle2 className="h-9 w-9 text-zinc-200 mb-2" />
            <p className="text-sm font-medium text-zinc-500">Nothing new</p>
            <p className="text-xs text-zinc-400">Client actions (payments, signatures, submissions) show up here.</p>
          </div>
        ) : (
          <>
          {notes.map((note) => {
            const handled = !!note.handled_at
            const busy = togglingId === note.id
            // Workflow notes carry the workflow task's own actions + SLA inline.
            const wfTask = note.task_id ? taskById.get(note.task_id) : undefined
            return (
              <div key={note.id} className={`rounded-md border bg-white p-2.5 ${handled ? 'opacity-60' : ''}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    {note.topic && (
                      <span className="inline-block text-[9px] font-semibold uppercase tracking-wide text-zinc-500 bg-zinc-100 border border-zinc-200 rounded px-1 py-px mb-1">
                        {note.topic}
                      </span>
                    )}
                    <p className="text-sm text-zinc-800">{note.text}</p>
                    <p className="text-[10px] text-zinc-400 mt-1">
                      {format(new Date(note.created_at), 'MMM d, yyyy · h:mm a')}
                      {' · '}{formatDistanceToNow(new Date(note.created_at), { addSuffix: true })}
                      {handled && note.handled_by ? ` · handled by ${note.handled_by}` : ''}
                    </p>
                  </div>
                  {/* No "Open card" for workflow notes — the workflow itself IS the to-do
                      and its action buttons are shown below. */}
                  {!handled && !wfTask && (
                    <button
                      onClick={() => open(note)}
                      className="shrink-0 flex items-center gap-1 text-[11px] font-medium text-violet-700 hover:text-violet-900 border border-violet-200 rounded px-2 py-0.5 bg-white"
                      title="Open a To-Do card for this"
                    >
                      <Plus className="h-3 w-3" /> Open card
                    </button>
                  )}
                </div>

                {/* Workflow note → render the workflow task's own stage actions + SLA inline. */}
                {wfTask && (
                  <div className="mt-2 rounded-md bg-zinc-50 border p-1.5">
                    <WorkflowTaskCard task={wfTask} today={today} role="admin" />
                  </div>
                )}
                <div className="mt-1.5 flex items-center justify-between">
                  <button
                    disabled={busy}
                    onClick={() => toggleHandled(note)}
                    className={`flex items-center gap-1 text-[11px] ${handled ? 'text-emerald-600 hover:text-emerald-800' : 'text-zinc-500 hover:text-zinc-800'} disabled:opacity-50`}
                    title={handled ? 'Mark as not handled (the dot returns)' : 'Mark handled — I know what to do (no card needed)'}
                  >
                    {busy ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : handled ? (
                      <CheckSquare className="h-3.5 w-3.5" />
                    ) : (
                      <Square className="h-3.5 w-3.5" />
                    )}
                    {handled ? 'Handled' : 'Mark handled'}
                  </button>
                  {handled && (
                    <button onClick={() => open(note)} className="text-[10px] text-zinc-400 hover:text-violet-700">
                      + card
                    </button>
                  )}
                </div>
                {/* Money actions — not on workflow notes (those carry their own action buttons). */}
                {!wfTask && (
                  <div className="mt-1.5 pt-1.5 border-t">
                    <CardCreateActions
                      accountId={cardAccountId ?? accountId}
                      contactId={contactId}
                      onDone={() => {
                        qc.invalidateQueries({ queryKey: ['thread-whats-new'] })
                        qc.invalidateQueries({ queryKey: ['portal-chat-thread-tasks'] })
                      }}
                    />
                  </div>
                )}
              </div>
            )
          })}
          {notes.length >= limit && (
            <button
              onClick={() => setLimit((l) => l + 100)}
              className="w-full text-[11px] font-medium text-violet-700 hover:text-violet-900 border border-violet-200 rounded px-2 py-1.5 bg-white"
            >
              Load older
            </button>
          )}
          </>
        )}
      </div>
    </div>
  )
}
