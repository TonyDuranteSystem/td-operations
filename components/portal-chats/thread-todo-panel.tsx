'use client'

/**
 * ThreadTodoPanel — per-client To-Do cards inside /portal-chats, driven by the
 * NEW Notification Center board (message_actions), NOT the tasks table. Lets
 * staff CREATE a to-do here (reflected on the CRM dashboard board) and complete
 * one. Pairs with the purple thread-list dot. See sysdoc notification-center-plan.
 */

import { useCallback, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Plus, CalendarClock, Check } from 'lucide-react'
import { createManualCard } from '@/components/dashboard/action-board-actions'

const API = '/api/crm/admin-actions/message-actions'

type Priority = 'normal' | 'high' | 'urgent'

interface TodoCard {
  id: string
  action_type: string
  label: string | null
  remind_at: string | null
  priority: Priority | null
  account_id: string | null
  contact_id: string | null
}
interface Col {
  slug: string
  display_name: string
  order: number
  terminal: boolean
}

const PRIORITY_PILL: Record<Priority, string> = {
  urgent: 'bg-red-100 text-red-700 border-red-200',
  high: 'bg-amber-100 text-amber-700 border-amber-200',
  normal: 'bg-zinc-100 text-zinc-500 border-zinc-200',
}

export function ThreadTodoPanel({
  accountId,
  contactId,
}: {
  accountId: string | null
  contactId: string | null
}) {
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [label, setLabel] = useState('')
  const [priority, setPriority] = useState<Priority>('normal')
  const [remind, setRemind] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { data: allOpen, isLoading } = useQuery<TodoCard[]>({
    queryKey: ['thread-todos', accountId ?? contactId],
    queryFn: () => fetch(`${API}?open=true`).then((r) => r.json()).then((d) => d.actions || []),
    refetchInterval: 30_000,
    enabled: !!(accountId || contactId),
  })
  const { data: columns } = useQuery<Col[]>({
    queryKey: ['thread-todo-columns'],
    queryFn: () => fetch(`${API}?columns=true`).then((r) => r.json()).then((d) => d.columns || []),
    refetchInterval: 120_000,
  })

  // Cards belonging to THIS client (account- or contact-scoped).
  const cards = useMemo(() => {
    const list = allOpen ?? []
    return list.filter((c) =>
      accountId ? c.account_id === accountId : contactId ? c.contact_id === contactId : false,
    )
  }, [allOpen, accountId, contactId])

  const refreshAll = useCallback(() => {
    qc.invalidateQueries({ queryKey: ['thread-todos'] })
    qc.invalidateQueries({ queryKey: ['portal-chat-open-todo-counts'] })
    qc.invalidateQueries({ queryKey: ['open-message-actions'] })
  }, [qc])

  const add = useCallback(async () => {
    if (!label.trim() || busy) return
    setBusy(true)
    setError(null)
    const remind_at = remind ? new Date(`${remind}T17:00:00`).toISOString() : null
    const res = await createManualCard({
      label,
      account_id: accountId ?? undefined,
      contact_id: accountId ? undefined : contactId ?? undefined,
      remind_at,
      priority,
    })
    setBusy(false)
    if (!res.success) {
      setError(res.error || 'Could not add the to-do')
      return
    }
    setLabel(''); setPriority('normal'); setRemind(''); setAdding(false)
    refreshAll()
  }, [label, priority, remind, accountId, contactId, busy, refreshAll])

  const complete = useCallback(
    async (id: string) => {
      const terminal = (columns ?? []).find((c) => c.terminal)
      if (!terminal) {
        setError('No "done" column is configured on the board')
        return
      }
      const res = await fetch(API, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action_type: terminal.slug }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        setError(d.error || 'Could not complete the to-do')
        return
      }
      refreshAll()
    },
    [columns, refreshAll],
  )

  if (!accountId && !contactId) {
    return (
      <div className="flex items-center justify-center py-6">
        <p className="text-sm text-zinc-400">Select a conversation</p>
      </div>
    )
  }

  return (
    <div className="border-b">
      <div className="px-4 py-2 bg-violet-50/60 border-b border-violet-100 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs font-medium text-violet-700">
          <span className="h-2 w-2 rounded-full bg-violet-500" />
          To-Do ({cards.length})
        </span>
        <button
          onClick={() => setAdding((v) => !v)}
          className="flex items-center gap-1 text-[11px] font-medium text-violet-700 hover:text-violet-900 border border-violet-200 rounded px-2 py-0.5 bg-white"
        >
          <Plus className="h-3 w-3" /> Add to-do
        </button>
      </div>

      {error && (
        <div className="mx-4 mt-2 text-xs text-red-600 bg-red-50 border border-red-100 rounded px-2 py-1.5">{error}</div>
      )}

      {adding && (
        <div className="p-3 space-y-2 bg-white border-b">
          <textarea
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            rows={2}
            autoFocus
            placeholder="e.g. Call the client about the missing passport"
            className="w-full text-sm border rounded px-2 py-1.5 resize-none"
          />
          <div className="flex gap-2">
            <input
              type="date"
              value={remind}
              onChange={(e) => setRemind(e.target.value)}
              className="flex-1 text-sm border rounded px-2 py-1.5 bg-white"
              title="Remind me by (optional)"
            />
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value as Priority)}
              className="w-28 text-sm border rounded px-2 py-1.5 bg-white"
            >
              <option value="normal">Normal</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
            <button
              disabled={!label.trim() || busy}
              onClick={add}
              className="flex items-center gap-1 text-sm font-medium bg-violet-600 text-white rounded px-3 py-1.5 disabled:opacity-40"
            >
              <Plus className="h-3.5 w-3.5" /> {busy ? 'Adding…' : 'Add'}
            </button>
          </div>
        </div>
      )}

      <div className="p-3 space-y-2">
        {isLoading ? (
          <div className="flex justify-center py-3"><Loader2 className="h-4 w-4 animate-spin text-zinc-400" /></div>
        ) : cards.length === 0 ? (
          <p className="text-xs text-zinc-400 px-1 py-1">No open to-dos for this client.</p>
        ) : (
          cards.map((card) => {
            const p = (card.priority ?? 'normal') as Priority
            const overdue = card.remind_at != null && new Date(card.remind_at).getTime() < Date.now()
            return (
              <div key={card.id} className={`rounded-md border bg-white p-2.5 ${overdue || p === 'urgent' ? 'border-l-4 border-l-red-400' : p === 'high' ? 'border-l-4 border-l-amber-400' : ''}`}>
                <div className="flex items-start gap-2">
                  <p className="flex-1 text-sm text-zinc-800">{card.label || '(no description)'}</p>
                  <button
                    onClick={() => complete(card.id)}
                    className="shrink-0 flex items-center gap-1 text-[11px] text-emerald-600 hover:text-emerald-800 border border-emerald-200 rounded px-1.5 py-0.5"
                    title="Mark done"
                  >
                    <Check className="h-3 w-3" /> Done
                  </button>
                </div>
                <div className="flex items-center gap-2 mt-1.5">
                  {p !== 'normal' && (
                    <span className={`text-[9px] font-semibold uppercase tracking-wide border rounded px-1 py-px ${PRIORITY_PILL[p]}`}>{p}</span>
                  )}
                  {card.remind_at && (
                    <span className={`flex items-center gap-1 text-[10px] ${overdue ? 'text-red-600 font-medium' : 'text-zinc-500'}`}>
                      <CalendarClock className="h-3 w-3" />
                      {overdue ? 'Overdue · ' : ''}
                      {new Date(card.remind_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                    </span>
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
